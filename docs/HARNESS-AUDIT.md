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

### 1b. The second defect, found while fixing the first

Fixing the above immediately exposed a second one, of the same shape and in
my own new code.

`decodeExecServerMessage` returned the **known** exec variants without their
field number, keeping it only for `unknown`. The refusal path was guarded by
`if (typeof exec.field === "number")`, so a `read_args` exec — Cursor's own
built-in read — was silently left **unanswered**. Cursor waits for every exec
to be answered, so the run stalled until the idle timeout and the request
returned nothing at all.

The symptom was sharp and misleading: `get_weather` worked, `read_file` hung.
The model, asked to read a file, chose Cursor's built-in read tool; we had no
reply slot for it; nothing was sent; the run waited forever.

Every known case now carries its own field, so any exec can be answered on the
slot the server will read it from, and a per-exec rejection table is no longer
needed for correctness. The lesson is the same one as §1: **a message that is
not answered is not a message that was handled.** The guard I added to make the
refusal path safe turned it into a silent one.

---

### The fourth defect: usage reported zero, forever

Every response carried `prompt_tokens: 0`. The decoder responsible looked for
`checkpoint.{1|2} → .8 → .1`, a path that matches nothing. The reference
implementation said `checkpoint.5 → .1`. One of the two was wrong, both fail
silently, and neither could be settled by argument.

Settled by capturing a real checkpoint and decoding it. Field 5 is empty on the
first minimal checkpoint and 286 bytes from the second turn on:

```
TokenDetails.field 1 = 10985     used tokens
TokenDetails.field 2 = 200000    the context window
TokenDetails.field 3             a per-section breakdown, `system_prompt` in it
```

The reference was right. The decoder now returns a real number — 10,851 on a
first turn, 10,952 on a resumed second.

The consequence was not just a wrong display value. The host derives its
compaction threshold from prompt tokens, so a permanent zero meant compaction
could not fire on real usage: context grew until something else broke.

**The pattern, now four times over:** the code encoded correctly, the feature did
nothing, and no error appeared anywhere. A wrong field path, a wrong sentinel, a
missing field number, a misclassified exec — four different mechanisms, one
symptom. That is what the type-checker and the counters exist to catch.

---

### The fifth defect: tool calls vanished on every replay

Same family, same silence. `renderColdStartHistory` skipped any message whose
rendered text was empty:

```js
const { text } = flattenContent(message.content);
if (trimmed.length === 0) continue;
```

An assistant message that made a tool call has `content: null`. It rendered as
empty, so it was skipped, and its `tool_calls` array was never examined. Every
tool call was dropped from every replay.

The model therefore saw:

```
[USER]        Check the deploy script and tell me the port.
[TOOL RESULT] PORT=8080
```

No call. No tool name. No arguments. It was handed a conclusion with the action
removed — unable to see what it had done, and unable to build on it. With several
tools in one round the results were undifferentiated blocks.

Found by rendering a realistic tool turn and reading the output, rather than by
reading the code. Calls now render as `[TOOL CALL] <name> <args>` and results as
`[TOOL RESULT (<tool>)]`, with tests for the arguments-missing case so the name
cannot be lost one level down.

---

### The native history path: built, verified, and not adopted

The typed history family is the right data model — a tool call should stay a call
with an id, a name and parsed arguments, not become a sentence the model has to
interpret. So it was implemented.

Encoders exist for every message in the family, `buildStructuredHistory` maps the
host's messages onto them, and the split was verified at the byte level:

```
TEXT-ONLY    action = "Continue the conversation below…"   history = none
STRUCTURED   action = "what port?"                          history = 125B
             └── containing the tool call and its arguments
```

That is exactly the shape intended: the action carries only the newest turn, and
the prior turns travel as native messages. A test walking the encoded bytes also
caught a real bug in the tool encoder — `ConversationHistoryMessage.tool = 3` was
nested one level too deep, inside field 1, so the wire would have carried a
message whose tool slot was empty.

**Then it was measured against the real server, and it stalls.**

| Sent | Result |
|---|---|
| Text transcript in the action | reply in 4.5 s, canary recalled |
| Structured history, with a tool call | no response in 120 s |
| Structured history, **plain text only** | no response in 90 s |

The third row is the decisive one: it is not the tool-call encoding, and not the
content at all. Populating `UserMessageAction.conversation_history` with
structured messages stalls the run, whether or not it contains anything exotic.
That is consistent with the image behaviour, which populates the same field.

So the native path is **opt-in and off** (`CURSOR_STRUCTURED_HISTORY=1`). It is
correct, tested, and documented; it is not shipped as the default, because the
server does not accept it. What remains unknown is whether it needs a companion
field — `replace_user_info`, or state the `conversation_state` normally carries —
or whether this endpoint simply does not want history on the action. That is the
next thing to try, and it needs captures rather than guesses.

---

### The instrument was blind, so the stall diagnosis was worthless

A workflow was run to settle why structured history stalls: seven shapes measured in
parallel, Cursor's own client read, an advisor and a critic in separate contexts, and
an unrelated model reading the same evidence cold. It found a problem with the
*measurement*, not the protocol.

All seven shapes replied, HTTP 200, in 4.0–6.5 s. **Nothing stalled.** The premise the
run was built to investigate did not reproduce, and the case meant to test it did not
test what it claimed: the script described `CURSOR_STRUCTURED_HISTORY=1` as moving
history into `ConversationState`, while the shipped code writes
`UserMessageAction` field 7 and leaves `turns` empty.

Then the real finding. `splitServerMessage` decoded four arms and dropped the rest:

```
AgentServerMessage|1 interaction_update|2 exec_server_message|5 exec_server_control_message
  |3 conversation_checkpoint_update|4 kv_server_message|7 interaction_query|8 ttft_breakdown
```

Arms 5, 7 and 8 produced **no frame object, no log line and no counter**.
`describeServerFrame` had been written for exactly this and had **zero call sites** —
dead code since it was added. And the `frames` / `lastFrameAt` values that
`cursor_doctor` reports as "is the model stuck?" were counted only for split frames.

**Confirmed live, immediately:** a plain `Say OK` request returns
`unknownFrames: {"8": 1}`. Arm 8 arrives on every run and had never been seen.

So the conclusion drawn earlier — "the server stalls when structured history is sent" —
was measured with an instrument that could not see a third of the wire. It is withdrawn.
Three other silent-but-fatal paths were found alongside it, all now counted and logged:

| Path | Why it stalls |
|---|---|
| An exec with no numeric field | the refusal is gated on `typeof exec.field === "number"`, so nothing is sent — and Cursor waits for every exec |
| A KV arm that is neither `get_blob_args` nor `set_blob_args` | no branch, so no reply |
| A `getBlobArgs` for a blob we never published | answered with an empty blob; the miss was silent |

The effective mode is now printed at startup, because a recorded stall cannot be
attributed to a path without it.

### The literal experiment: turns in state are ignored

With the instrument fixed, the control/test pair the withdrawn diagnosis called
for was run — the only test that separates "dropped" from "held":

| Run | Where the pair travelled | Result |
|---|---|---|
| CONTROL | text transcript in the action | **"Alice"** recalled, 8.0 s |
| TEST | `ConversationState.turns`, blob-published ids, field 7 empty | **no memory of Alice** — the model replied *"I'll look for your name in workspace settings or profile files"* |

The turns were encoded as `ConversationTurnStructure{agent_conversation_turn}` with
the user message and assistant step inside, SHA-256-hashed, published to the blob
store exactly as the root prompt travels, and referenced by id — matching the
reference's warning that "current Cursor servers treat them as blob ids" and the
32-byte ids observed inside real checkpoints.

**The server ignored them.** The model's answer is unambiguous: it tried to *search*
for the name, which means the prior turns never reached its context. The test run
also never closed cleanly — no `finish_reason`, no `[DONE]`, and 2-byte interaction
frames continuing after the checkpoint — because the model, having no tools
registered, kept trying to look the answer up.

So both candidate locations for native history are now measured, not assumed:

| Location | Result |
|---|---|
| `UserMessageAction.conversation_history` (field 7) | all seven shapes replied, HTTP 200, 4–6.5 s; canary recalled in the text cases |
| `ConversationState.turns` (blob-published ids) | **ignored** — no recall, model unaware of prior turns |

**The undecoded arms are counted, not fixed.** Whether arm 8 needs a reply is unknown;
what is known is that its absence from every previous diagnosis was an assumption nobody
had checked.

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
| Cursor's own built-in execs are answered, not ignored | every known case carries its field; `read_file` returns in 7 s instead of hanging |
| Usage carries Cursor's real token count | 10,851 first turn, 10,952 resumed — was 0 forever |
| Every turn anchors, and a resume engages | `conversations: 1` then `resumed: 1, resumeRate: 0.5` |
| ConversationState.turns (blob form) is ignored by the server | control recalled Alice; the turns run answered "I'll look for your name in workspace settings" |
| Arm 8 is TTFT telemetry and arrives on every run | decoded live: server/provider first-token timings |
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

### The third defect, and the largest of the three

`conversations: 0` was recorded for months of work as "Cursor never sends
checkpoints, so the resume path cannot engage". That was wrong. Cursor sends a
checkpoint on **every** turn — three of them on a single plain `PONG` — and the
shim threw each one away.

The sentinel for "no tool call" was `null`:

```js
let toolCall = null;              // #collect
if (result.toolCall !== undefined) { /* treat as a terminal tool call */ }
```

`null !== undefined` is true, so **every turn ever run** took the tool-call
branch, discarded its anchor, and reported a resume rate of zero. The interlock
was correct the whole time; the two halves of the code simply disagreed about
which value means "absent".

Found by instrumenting `#commit` rather than by reading it: the log said
`checkpoint=523B toolCall=yes` on a request that registered **no tools** and
performed **no tool call**, which is impossible unless the sentinel was wrong.

Fixed by making the check total (`!= null`) and extracting the rule into
`canAnchorTurn`, so the two halves cannot diverge again.

**Verified live, for the first time in this project:**

```
turn 1  →  conversations: 1
turn 2  (exact extension)  →  resumed: 1, resumeRate: 0.5
```

Server-side conversation reuse works. The design that was believed dead is
live, and every claim about it can now be tested rather than assumed.

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

7. **No inter-chunk watchdog.** A first-token timeout does not bound a
   long-lived HTTP/2 stream; a stall after the first delta would hold the host's
   stream until its own idle timeout. Needs a gap watchdog between frames
   (§4.8).

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

## 3b. The reinstall trap, and why it is now closed

Found by tripping it: a forced reinstall wiped the data directory, the next
launch minted a new shim key, and the user's provider entry still held the old
one. Every turn failed `invalid api key` with no indication of why.

Two independent causes, both outside the shim's control:

- **ZCode writes `provider_config.json` from an in-memory copy.** A provider the
  uninstall removed can reappear.
- **A reinstall rotates the shim key**, because the key lives in the wiped data
  directory, while the provider entry lives in a file that is not.

Which means a reinstall can produce a correctly addressed provider that is
permanently 401 — and the user is the one who finds out.

Closed by two things, because either alone leaves a gap:

1. `reconcileProviderKey` runs when the shim starts. If a provider already points
   at this shim and its key is stale, the key is rewritten and the repair is
   logged. It never creates a provider, never touches the model list, and never
   writes when there is nothing wrong.
2. `ensureShimProvider` refreshes the key on an existing entry, so re-running
   the setup is a repair rather than a no-op.

`cursor_doctor` also reports the mismatch, comparing SHA-256 digests in constant
time so neither key is echoed back. **Verified end to end**: with a deliberately
stale entry present, merely starting the shim repaired it — key matched, 241
models untouched, no user action.

The residue is a discipline, not a bug: **a reinstall is not a setup.** The user
must run `/connect-cursor-and-initialize` again, and should fully quit (⌘Q)
rather than close the window so ZCode reloads the file instead of overwriting it.
That is written into `AGENTS.md` so an agent cannot rediscover it the hard way.

---

## 4. What the literature says we got wrong, and what it fixed

Sources gathered while fixing §1, with the parts that changed this codebase marked.

### 4.1 A counter invariant would have caught it without running a model

The recommendation that mattered most: count the tool requests the upstream
makes and the `tool_calls` the shim emits, and alert on any gap. A gap *is* the
bug, and it is visible from counters alone — no model required.

Implemented. `cursor_doctor` reports `N of M tool requests delivered` and treats
a drop as a fault; `cursor_status` shows the three counters side by side.

### 4.2 Termination is decided by classification, never by the absence of text

OpenAI's agent loop defines a final answer as text output "**and there are no
tool calls**" ([OpenAI Agents SDK](https://openai.github.io/openai-agents-python/running_agents/)).
Providers routinely emit a preamble *and* a tool call, so "there is text" can
never imply "no tool call". The original bug produced exactly that
misclassification: a `stop` with text where a tool call belonged. The fix
classifies the exec **before** choosing a `finish_reason`.

### 4.3 Silent failure is the named enemy

SWE-agent tripled pass@1 with no model change, purely through interface
design, and names its principle directly: guardrails should "block common
mistakes and return concise, specific error feedback rather than silent
failures" ([SWE-agent](https://arxiv.org/abs/2405.15793)). This is why the
client-error taxonomy exists — a caller's mistake reported as a 5xx sends the
host hunting a server bug that is not there.

### 4.4 A refusal is a result, not a non-event

Anthropic returns errors to the model as a tool result with `is_error: true`;
OpenAI's SDK has `tool_not_found_behavior="return_error_to_model"`. Silence is
indistinguishable from completion — which is precisely the asymmetry that made
the original bug look like a working chat box.

**Considered and not adopted:** fabricating a synthetic `tool_calls` response
for Cursor's own built-in execs, so the refusal travels through the host as a
tool result. Rejecting on the wire and continuing keeps the loop inside
Cursor's protocol, and is the behaviour the upstream project documents and
observes working. Worth revisiting if a future protocol version stops the
model from falling back after a wire-level refusal.

### 4.5 Delivery and registration are different events

MCP separates "schemas are delivered" (`tools/list`) from "the client has
registered them", with `notifications/tools/list_changed` to re-fetch. A schema
that is delivered but never registered produces precisely the symptom we had.
The closest public account of the same failure is an unanswered LibreChat
discussion about tool calls received but never executed on a custom
OpenAI-compatible endpoint
([discussion #14822](https://github.com/LibreChat-AI/LibreChat/discussions/14822)).

The mid-stream schema handshake itself is **undocumented and unverified against
any public source** — it traces only to the reverse-engineered `agent.v1`
protocol. It can only be validated from our own captures.

### 4.6 Cache invalidation rules out caching the tool set

Tool definitions are hashed ahead of system and messages, so "modifying tool
definitions invalidates the entire cache"
([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)).
The set this shim presents upstream must therefore be a pure function of the
host's request. It is, and should stay so.

### 4.7 Context rot is measured

Recall degrades as history grows ([Effective Context
Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)),
so tool contracts from early in a long conversation are effectively absent even
when literally present. The prefix-exactness check before resuming is the right
invariant, and now has tests.

**Unverified:** we found no quantitative study of tool-definition drift after
compaction specifically. Treat the mitigation as engineering practice, not
measured result.

### 4.9 "Is the model stuck?" has to be answered from evidence

There is no model-status endpoint in Cursor's protocol, so the only honest
answer is when the last frame arrived and what was last done with it. `/health`
now reports `frames`, `lastFrameAt` and `lastAction`.

This exists because the second defect was diagnosed by reading a debug log by
hand. The trace showed frames arriving, then an exec, then silence — which is
the model *waiting for a reply we never sent*, not the model stuck. That
distinction should not require an expert squinting at a log: frames still
arriving means the model is working; silence immediately after an exec we did
not answer means it is blocked on us.

The generalisable point, and the one that matters beyond this project: **an
agent narrating an action is not the same as an agent performing it.** A model
that says it will run `git status` has told you nothing. The evidence is a tool
call in the trace, or a counter that moved.

### 4.8 A first-chunk timeout does not cover a mid-stream stall

LiteLLM notes `stream_timeout` bounds only the first chunk
([docs](https://docs.litellm.ai/docs/proxy/timeout)). Our upstream is a
long-lived HTTP/2 stream, so a time-to-first-token bound alone is not enough —
an inter-chunk watchdog is required. **Open item**, see §3.

---

## 5. What to do when a Cursor turn fails

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

## 6. Why the tests are shaped this way

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
