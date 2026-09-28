# Harness audit

An audit of the shim as an agent harness, written after the defect that made
tool calling silently dead. It records what was wrong, what is now proven, and
what is still open. Every "proven" line names the command that proves it.

---

## 1. The defect that motivated this

**Tool calling never worked. Not once. It only looked like it did.**

A model was given a tool, decided to call it, and the call never reached the
host. The turn ended as an ordinary `stop` with no `tool_calls`, so ZCode had
nothing to execute. The user described it exactly right: *"Cursor models are
working but it's working without tool calling. Without tool calling it's just a
standard chat box."*

### Root cause

`CursorShim` treated **every** exec that was not `request_context_args` as a
terminal tool call:

```js
toolCall = exec;
run.end();
break;                      // ← and then #toToolCall() returned null
```

Cursor's protocol uses one message type for several unrelated things. Besides
the tool call itself, a single run carries:

| Exec | What it is | Should the run end? |
|---|---|---|
| `request_context_args` (field 10) | "send me the tool schemas" | no — answer it |
| `mcp_args` (field 11) | **the actual tool call** | **yes** |
| field 36 | the provider routing this model into our MCP provider | no — answer it |
| `read_args`, `shell_args`, … | Cursor's own tools, which the host owns | no — refuse them |

Ending the run on the third and fourth kinds meant the turn was cut short before
the model could emit `mcp_args`. `#toToolCall` then returned `null` because the
exec was not an `mcp_args`, and the turn was reported as a clean `stop`.

### Why nothing caught it

Every layer encoded correctly. The protobuf was right, the SSE was right, the
token counts were right, the response shape was right. The feature was still
absent, because the failure was in *control flow*, not in encoding.

The upstream `dsh-cursor-subscription` has the same gap, and its own source
comments on it:

> "Cursor adds exec variants without notice (field 36 appeared this cycle).
> Answer on the exec's own field with the generic error shape, so the model
> learns the tool is unavailable and falls back to the MCP tools; **live probing
> shows every coherent reply resumes the run while silence stalls it.**"

The behaviour was understood and documented upstream, and still not implemented
here. `TOOL_REJECT_REASON` was defined in this codebase and never referenced.

### The fix

```js
if (exec.case === "requestContextArgs") { run.sendToolDefinitions(...); continue; }
if (exec.case === "mcpArgs")            { toolCall = exec; run.end(); break; }
run.rejectExec(exec.id, exec.execId, exec.field, TOOL_REJECT_REASON);  // own field
continue;
```

A refusal is an `McpResult { error = 2 }` written **on the exec's own field
number**, because the server routes the reply by that slot. Silence leaves the
run waiting forever.

---

## 2. Proven

| Claim | Evidence |
|---|---|
| The model emits a real tool call | `finish_reason: "tool_calls"`, `get_weather({"city":"Paris"})` |
| The tool is executed and the result used | turn 2 answers a canary that exists only in the file the tool read |
| It works across four model families | Composer, Grok, GPT and Claude all pass `live-roundtrip.mjs` |
| The right tool is chosen from two | `live-conversation.mjs` — `get_weather` over `convert_currency` |
| Mid-session steering is followed | user switches Oslo → Bergen; the model calls with Bergen |
| The system prompt survives tool turns | a one-sentence instruction set at turn 1 still holds at turn 3 |
| Tool calls survive streaming | 18 SSE frames, all with `choices`; `finish_reason: "tool_calls"` on a populated frame |
| A tool result is never dropped on a resumed turn | the interlock refuses to resume; the replay carries it as `[TOOL RESULT]` |
| No malformed input wedges the shim | 12 malformed requests, then a real completion still answers `PONG` |
| Client errors are 4xx, not 5xx | bad JSON → `400 bad_json`; missing messages → `400 no_messages` |
| A refusal loop cannot hang | bounded by `MAX_EXECS_PER_RUN` / `MAX_REFUSALS_PER_FIELD` |

```
CURSOR_LIVE_TESTS=1 node test/live-roundtrip.mjs <models>
CURSOR_LIVE_TESTS=1 node test/live-conversation.mjs <model>
node test/sad-paths.mjs
node --test test/*.test.mjs
```

---

## 3. Open, in priority order

### Investigated and closed

**Tool results across a resumed turn — not a defect.** Inspection suggested
`buildRunRequest` takes only `lastUserMessage(messages).text` as the action and
never sends `role: "tool"` messages, which would lose the result on any resumed
turn. Testing it says otherwise: `planTurn` returns `resumable: false` as soon
as the history contains a tool result Cursor has not seen, so the turn replays,
and `renderColdStartHistory` carries the result labelled `[TOOL RESULT]` while
the newest user turn becomes the action. The system prompt is published as a
blob and is correctly *not* replayed inline. Both halves are now locked in by
tests, so the guarantee cannot rot silently — which is the whole lesson of §1.

### High

1. **Refusals are generic.** The reference has a per-exec rejection table
   (`encodeReadRejected(path, reason)`, `encodeShellRejectedResult`, …). This
   shim sends the same `McpError` for every exec and does not extract the path,
   so the model is told a tool is unavailable without being told which or why.
   The generic reply is proven sufficient for the run to resume; the tailored
   one should give the model a better reason to fall back.

2. **Parallel tool calls are untested.** Cursor may issue several `mcp_args`
   before the turn ends. The shim returns at the first one. Whether the
   remaining calls are lost, replayed, or duplicated on the next turn is unknown.

3. **Parallel tool calls are untested across a stream.** Single tool calls now
   verified over SSE (18 frames, every one carrying `choices`, the `tool_calls`
   delta, `finish_reason: "tool_calls"`, then a usage-only frame with
   `choices: []` — the contract ZCode's parser enforces). Several `mcp_args` in
   one turn is still unverified.

### Medium

4. **No live test for the resume path.** Checkpoints have never arrived from
   Cursor (`conversations: 0`, resume rate 0), so the resume branch is covered
   only by unit tests. Until a checkpoint is observed the whole resume design is
   unproven against the real server.

5. **Latency is unmeasured.** No budget, no regression alarm. A turn that should
   take 6 s should not silently become 60 s. The live probes now print per-turn
   timings, which is the start of this, not the end.

6. **No circuit breaker on repeated upstream failure.** A transient `api2.cursor.sh`
   error should surface as a clean error to the host, not as N retries.

### Low

8. `decodeExecServerMessage` returns `case: "readArgs"` without the path, unlike
   the reference. Only matters if the tailored rejection in (2) is implemented.

9. Field numbers are a moving target. A new exec variant will be refused rather
   than decoded, and the run will continue — correct, but the tool will not
   work until someone adds the case. There is no alert for this beyond the model
   falling back to text. **Consider:** count refusals per field across a session
   and surface a warning in `cursor_doctor` when a field is being refused
   repeatedly, since that is the signature of an unimplemented exec variant.

---

## 4. What to do when a Cursor turn fails

The failure modes are not the same, and the timing is the tell.

| Symptom | Meaning | Action |
|---|---|---|
| Fast failure, HTTP 4xx | The caller's mistake | Fix the request. Not a shim bug |
| Instant `fetch failed` | Nothing is listening on the port | `cursor_doctor`; restart ZCode |
| First probe ~5 s, rest ~0 ms | Connect timeout, then refused | The shim is not serving |
| `finish_reason: stop` with prose that promises a tool call | The exec arrived and was mishandled | **This was the bug in §1.** Check the exec handling |
| Unknown exec refused repeatedly | A protocol variant newer than this build | Add the case; see (9) |
| Run hangs with frames still arriving | Refusal loop | Bounded by `MAX_REFUSALS_PER_FIELD`; check that limit |
| Stalled, no frames at all | Upstream or the stream idle timeout | `CURSOR_SHIM_DEBUG=1` prints every frame |

**Never retry a failed Cursor run automatically.** The streaming protocol cannot
prove a failed attempt was not processed remotely, so a retry can duplicate work
and spend the user's quota.

---

## 5. Why the tests are shaped this way

The defect in §1 was invisible to unit tests and obvious to a live probe. So the
suite is split by what each kind of test can actually catch:

- **Unit (`test/*.test.mjs`)** — wire formats, field numbers, the resume
  interlock, credential handling, teardown. Free, fast, runs in CI on three Node
  versions. Catches "the bytes are wrong".
- **Live probes (`test/live-*.mjs`)** — that a model actually calls a tool, uses
  the result, follows steering, and honours a system prompt across turns. Costs
  quota, so they are gated behind `CURSOR_LIVE_TESTS=1` and never run in CI.
  Catches "the feature does nothing".

The gap that bit us was entirely in the second column. A harness can be
byte-perfect and still not work, so anything that claims a capability needs a
probe that spends a real request.

Debugging the wire is cheap: `CURSOR_SHIM_DEBUG=1` prints every frame kind, every
exec case, and the raw bytes of each exec. That is what turned "the tool call
does not fire" into "field 36, which the decoder does not know" in one run.
