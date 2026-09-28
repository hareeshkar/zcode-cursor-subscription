# Review — cursor-subscription plugin

**Revision reviewed.** The working tree was being edited by another process throughout this
review (mtimes advanced 15:20 → 15:39 mid-session; `lib/import-local.mjs` appeared at 15:39).
This report is pinned to the snapshot taken at **15:39:25–15:39:48** and copied to
`/tmp/verify-review/snap/`:

```
0edb999e…  lib/cursor-client.mjs    a31a918f…  lib/shim.mjs
a1b2…(see shasum in transcript)     fe89849c…  scripts/mcp-server.mjs
abcffd07…  lib/conversation-store.mjs           b77be25c…  lib/conversation.mjs
```

Line numbers below are from that snapshot. Several findings filed earlier in this review were
**fixed while it ran**; those are listed under *Corrections*, not as live defects.

**Not run:** the plugin's test suite (`node --test test/conversation-store.test.mjs`) — the
orchestrator reported it green and the ask said not to re-run it. Every finding below is from
reading the code, from grep, or from scratch probes under `/tmp/verify-review/`.

---

### Verdict

The architecture is sound and the boundary discipline is the strongest thing here: a
protocol-translating shim that owns *only* serialisation, so ZCode's own tools, permissions and
compaction keep working unchanged, is the right answer to "ZCode has no provider hook". The
implementation does not yet meet that bar — tool calls cannot work at all, and the two
conversation-correctness mechanisms the whole design rests on (blob persistence, tool-call
invalidation) are absent, so a green suite is measuring a store that no live path exercises.

---

### Critical

#### C1 — `decodeMcpArgs` implements a protocol that does not exist; no tool can ever run
`lib/cursor-client.mjs:372`

Reference schema is `McpArgs { name=1, args=2 (map<string,bytes>), tool_call_id=3,
provider_identifier=4, tool_name=5 }` (dsh `lib/index.js:1516`). Our decoder maps field 1 →
`decodeTextDelta` (a *message* decode of what is a plain string), field 2 → `decodeTextDelta`,
field 3 → raw `JSON.parse`, and **discards fields 4 and 5 entirely** via the
`reader.skip` fallthrough at `:389`.

Reproduced on the pinned snapshot (`node /tmp/verify-review/probe2.mjs`):

```
STILL BROKEN  decodeMcpArgs on a canonical McpArgs message
      THREW Error: protobuf: truncated bytes
name omitted ->  {"toolName":"","callId":"path","args":{}}
```

**Failure:** the decoder reads a string's bytes as a length-delimited submessage and walks off
the end. With no `try/catch` between `decodeMcpArgs` and the frame loop
(`shim.mjs:316` → `:331` → the `try{}finally{}` at `:288-335`), the `TypeError` propagates to
the 502 handler at `:459-471` — the turn dies. The one shape that doesn't throw returns
`toolName: ""`, which `#toToolCall` (`shim.mjs:362`) rejects, so the call is silently dropped and
the turn completes as `finish_reason: "stop"` with `content: null`. 341 of 376 name fixtures
throw; all realistic names throw.

**Owner:** `cursor-client.mjs` — the wire schema is not ours to design.

**Smallest fix:** port the reference decoder verbatim (`index.js:1516-1543`), import the
`decodeValue` that `proto.mjs:251` already exports, and read `exec.args.toolName || exec.args.name`
at `shim.mjs:363` as `index.js:3250` does. Make an unresolvable exec *report* rather than
degrade to an empty `stop`.

#### C2 — The blob store is per-request, so a resumed turn serves an empty system prompt
`lib/shim.mjs:247`, `lib/conversation-store.mjs:148`

`const blobStore = new Map()` is created inside `#chatCompletions` per HTTP request and passed
to `buildRunRequest`. On the checkpoint path, `conversation.mjs:185-189` sets
`conversationState = checkpoint` and never copies blobs in — only the cold-start branch does
(`:194`). `#commit` persists `{ checkpoint }` only (`shim.mjs:356-358`), and
`ConversationStore#record` has no blob field at all (`conversation-store.mjs:148`).

**Failure:** every resumed run and every tool step is a new request with an empty store. When
Cursor issues `get_blob_args` for the root-prompt blob, `shim.mjs:306` passes `undefined` to
`encodeGetBlobResult`, which is a *faithful* port of the reference (`cursor-client.mjs:174-178`
— the reference does the same) and yields a structurally valid success ack with a **zero-length
body**: `1a06080712020a00`. Not an error, not a stall. ZCode's entire system prompt — skills,
memory, environment, compaction policy — silently vanishes for the rest of the session, and
nothing anywhere reports the miss.

The reference does the opposite and tests it: `blobStore = persisted.blobs ?? new Map()`
(`index.js:2273`), re-seeded per session (`:2926`), retained "for both this run's GET handshake
and the next run's checkpoint" (`:3212-3216`), cleared only on invalidation (`:2991`).

**Owner:** the store. The blob closure is exactly as much conversation state as the checkpoint;
it belongs in the same record.

**Smallest fix (4 edits, no new abstraction):** `record(…, { checkpoint, blobs })` persists
`blobs: new Map(blobs ?? [])`; `find` returns `blobs: best.blobs`; `shim.mjs:247` becomes
`new Map(anchor?.blobs ?? [])`; `shim.mjs:358` passes `blobs: ctx.blobStore`. `forget`/`clear`
already drop the whole entry, so blobs die exactly when the checkpoint does. Do **not** widen
`buildRunRequest`'s parameters to take the anchor — lifetime is the store's business.

Safe against the §6.9 interlock: the prefix hash covers the system message, so any change to it
forces a replay, and a replay re-derives the blob id as `sha256(payload)` (`conversation.mjs:148`).

#### C3 — A run paused on a tool call is anchored and then resumed, dropping the tool result
`lib/shim.mjs:349-359`

`#commit`'s only guard is `result.checkpoint === undefined`. Nothing inspects
`result.toolCall`, even though `#collect` sets it and breaks at `shim.mjs:318-330` and
`:332`. `find` returns the *longest prefix* match (`conversation-store.mjs:123-145`), so the
shorter pre-exec anchor written last turn is selected again next turn.

**Failure:** turn 1 = `[system, user]`, Cursor asks for a tool. Turn 2 = ZCode's
`[system, user, assistant(tool_calls), tool(...)]` (ZCode emits `role:"tool"` with no synthetic
user message). The shim resumes from checkpoint A with `actionText = lastUserMessage(messages)`
(`conversation.mjs:187-188`) — which is *turn 1's user message*, already inside the checkpoint.
The tool result is never transmitted in any field, yet the turn is reported as a successful
resume. The reference refuses exactly this pairing and falls back to cold start:
> `if (liveBridge !== undefined) { … // A checkpoint paused on an MCP call cannot safely accept
> a normal user action.` (`index.js:2985-2992`)

This is also where the §6.9 interlock gives false comfort: it validates the *prefix*, and the
lost data is in the *suffix*.

**Owner:** the shim.

**Fix — two changes, and the second is mandatory.** Forcing a cold start alone still loses the
tool result: `renderColdStartHistory` takes the last USER entry as the action and slices
`prior` to everything *before* it (`conversation.mjs:116-118`), so with no new user message the
ASSISTANT and TOOL RESULT entries fall off the end and are discarded.

1. `shim.mjs:349` — make a tool-call turn ineligible to become an anchor. Use a **prefix-wide**
   forget, not the existing exact-key `forget` (`conversation-store.mjs:169`), or the shorter
   anchor will be re-selected next turn.
2. `conversation.mjs:102-127` — `renderColdStartHistory` must not discard messages *after* the
   last user message; append them to the history as labelled text.

Do not thread the tool result into the checkpoint — that is the live-bridge path the reference
only uses on the same open run, and §6.9 does not cover it.

#### C4 — The tool-definition reply is framed on the wrong protobuf field, twice
`lib/cursor-client.mjs:156`, `:148`, `:557-558`, `:597`

The mid-review fix for the exec handshake was **ported with two wrong field numbers**:

| | ours | reference (`index.js`) |
|---|---|---|
| `AgentClientMessage.exec_client_message` | **1** (`:156`) | **2** (`:1080-1082`) |
| `ExecClientMessage.exec_id` | **2** (`:148`) | **15** (`:1074`) |
| correlation | `encodeExecClientMessage(0, "", 10, …)` (`:598`) | `(exec.id, exec.execId, 10, …)` (`:3225`) |

And the old bare pre-push at `:557-558` is still there, still field 1. Verified on the pinned
snapshot (`node /tmp/verify-review/probe2.mjs`):

```
bare tool-schema frame:  top-level field 1 wiretype 2; first bytes 0a5f0a5d — field 1 = run_request
reply from sendToolDefinitions():  top-level field 1
```

**Failure:** both the unsolicited push and the handshake reply are framed as `run_request`, so
the tool schemas are never delivered. The pre-push collides in the same oneof with the real run
message written at `:559`, a few hundred microseconds later — last-one-wins, silently discarded.
`sendToolDefinitions` also sends `id=0, execId=""`, so even a correctly framed reply could not be
correlated back to the exec that asked.

**Fix:** field **2** in the envelope, field **15** for `exec_id`, thread the decoded
`exec.id`/`exec.execId` through from `shim.mjs:318`, and **delete the pre-push at `:557-558`**
entirely. Tool schemas are a *reply*, never a request-initiating message.

#### C5 — `prompt_tokens` is permanently zero, so ZCode's compaction threshold is fiction
`lib/cursor-client.mjs:273`

Our path: field 1-or-2 → field 8 → varint field 1. Reference: **field 5** → varint field 1
(`index.js:1305-1318`). Field 8 is `turns` in the very message the plugin encodes
(`cursor-client.mjs:117,125`), so the current lookup reinterprets a turn as token details.

Verified: `node /tmp/verify-review/probe2.mjs` — a reference-shaped checkpoint `{5:{1:41123}}`
returns **`undefined`**. `#usage` (`shim.mjs:392-396`) then reports zeros.

**Why it is critical, not cosmetic:** the doc comment at `shim.mjs:385-391` states the shim
reports Cursor's own accounting *precisely because* ZCode derives its compaction threshold from
it. The §6.11 contract "the shim owns token-accurate usage" is not met; ZCode compacts on a
made-up number. `RESEARCH-FINDINGS.md:729` already records this as a known source of error.

**Fix:** one pass — iterate the checkpoint's top-level fields, on `field === 5 &&
wireType === 2` return the first `field === 1` varint.

---

### Important

**I1 — No abort propagation.** `shim.mjs:270` `new AgentRun(accessToken)` passes no signal, yet
`frames()` checks `this.signal?.aborted` (`cursor-client.mjs:636`). When ZCode cancels or retries
a turn, the Cursor run keeps streaming for up to the 120 s idle timeout, holding a
bearer-authenticated HTTP/2 session and burning the user's quota on unread output. Nothing reads
`request.on("close")`. Fix: thread `request.signal` into the constructor — the plumbing below it
already exists. Note `README.md:112` and `SKILL.md` rule 4 claim "do not retry a failed run"; the
host owns retry, so reword rather than assert.

**I2 — The whole run is buffered before the first SSE byte.** `#stream` writes headers at
`shim.mjs:399` but no data until `:443`, after `#collect` resolves. Time-to-first-token equals
the entire Cursor run. ZCode's default per-`next()` stream idle timeout is 600 s
(`packages/contracts/src/config/index.ts`), and a stall is classified `retryable`
(`failure-classifier.ts:126-135`) with an 11-attempt budget (`retry-policy.ts:13`) — so one slow
turn becomes up to 11 Cursor runs. Fix: pass a writer into `#collect` and emit a chunk per
`textDelta`/`thinkingDelta`. The per-frame loop already exists.

**I3 — `frames()` can livelock the process.** `cursor-client.mjs:642-646`: when the reader
returns `undefined` (`proto.mjs:433` — stream ended, queue drained) but `#closed` is still
false, `continue` re-enters on an already-resolved promise. `#closed` is set only by the
stream's `close` event, which needs a macrotask the loop never reaches. Measured on this
revision: 2,000,000 `next()` calls with no event-loop turn, 100% CPU, memory flat; end-to-end, a
server that streams 3 deltas and calls `stream.end()` without an END_STREAM frame pinned a core
for 119 s and then returned a fabricated `CURSOR_IDLE_TIMEOUT` — discarding text the turn had
already produced. `next()` checks `queue.length` before `#ended` (`:432-433`), so `undefined`
*already* means "finished and drained". Fix: replace the block with `if (frame === undefined)
return;`, matching `index.js:3115-3116`.

**I4 — The decompressed-frame cap is not enforced.** `proto.mjs:399` bounds the **compressed**
`length`, then `:405` calls `gunzipSync(raw)` with no `maxOutputLength`. A 97 KB frame
decompressed to 96 MiB in the reported probe. Fix:
`gunzipSync(raw, { maxOutputLength: MAX_CONNECT_FRAME_BYTES })`, letting `ERR_BUFFER_TOO_LARGE`
surface through the existing catch.

**I5 — `handle.sync()` is dead code; credentials are never fsynced.**
`credentials.mjs:135-140`: `fs.promises.writeFile` resolves to `undefined`, so `handle.sync()`
throws `TypeError` on every call and the empty `catch` at `:141` swallows it. Verified:
`fs.promises.writeFile resolved to: undefined`. The atomic-rename durability the comment at
`:126-131` promises does not happen. Fix: `openSync(tmp, O_WRONLY|O_CREAT|O_EXCL, 0o600)` →
`writeSync` → `fsyncSync` → `closeSync` → `rename`, and log an fsync failure instead of
swallowing it.

**I6 — The credential compare-and-swap has no lock.** `credentials.mjs:163-174` is
read-then-write with nothing held across the two, and two `CredentialStore` instances exist
in-process (`mcp-server.mjs:41`, `scripts/shim.mjs:40`). Two concurrent refreshes both pass the
check, both spend the same refresh token, and the loser's rotation is silently overwritten — a
permanent silent sign-out. Fix: a sibling `.lock` with `flag:"wx"`, released in `finally`.

**I7 — Concurrent turns can resume the same server conversation.** No in-flight guard, lock or
per-conversation serialisation anywhere: `find` (`shim.mjs:205`) is a lock-free scan, each
request opens its own `AgentRun` against the same checkpoint, and `record` is last-write-wins on
`hashMessages` (`conversation-store.mjs:148`). The reference keeps one live bridge per session
(`index.js:2842`). Fix: track in-flight keys; if a key is already in flight, cold-start.

**I8 — Metrics count intent, not outcome.** `turns` increments at `shim.mjs:202` before any
Cursor call; `resumed`/`replayed` at `:213/:215/:218` before `buildRunRequest`. `#commit` — the
actual outcome, `:440/:475` — touches no counter and is skipped entirely when `#collect` throws.
`resumeRate` is therefore wrong from the first failed turn, and it is what `/health` and
`cursor_status` report. Fix: move all three increments into `#commit`.

**I9 — An identical message array is classified resumable with an empty suffix.**
`conversation-store.mjs:87` returns `{resumable: true, suffix: [], reason: "resumed"}`. ZCode
re-sends the identical array on every retry. The shim then re-sends the last user message as the
action on top of a checkpoint that already contains it. Fix: treat `plan.suffix.length === 0` as
not resumable.

**I10 — An assistant turn carrying only `tool_calls` is dropped from cold-start history.**
`conversation.mjs:106-111` skips any message whose flattened text is empty; a `tool_calls`-only
assistant message has `content: null`, so the replayed transcript shows a `[TOOL RESULT]` block
with no call that produced it. Fix: render `[ASSISTANT TOOL CALL] name(args)`.

**I11 — `cursor_login` cannot fit in the host's 30 s MCP budget.** `auth.mjs:248` polls up to
150 times with backoff capped at 10 s (`:266`) — ~23.6 minutes of human browser interaction.
ZCode's default is `DEFAULT_MCP_TIMEOUT_MS = 30_000` and `.mcp.json` declares no `timeoutMs`, so
the tool always reports failure. The credential *does* land (the loop is un-abortable), which is
worse: the agent's only rational response is to retry, and each retry opens a second browser
window and a second 23.6-minute poll loop racing on `store.save`. Fix: emit
`notifications/progress` on each poll so ZCode's `resetTimeoutOnProgress: true` renews the
budget, **and** single-flight `login()` at module scope. (I could not read
`@modelcontextprotocol/client@2.0.0` — no `node_modules` in the ZCode checkout — so the
progress-reset semantics rest on the option name, not on code I ran. The certain fallback is
`"timeoutMs": 1800000` in `.mcp.json`, which `mcp.ts:241` honours.)

**I12 — EADDRINUSE kills the MCP server.** `shim.mjs:112` attaches no `'error'` listener, and
`mcp-server.mjs:191-195` wraps `shim.listen()` in `try/catch` — but `listen()` reports EADDRINUSE
asynchronously, so the catch cannot fire and the unhandled `'error'` event kills the stdio
server. This is precisely the case the comment at `:188-190` calls harmless. Fix: attach an
`'error'` handler in `listen()` and treat EADDRINUSE as "another instance is serving".

**I13 — Refusing a Cursor built-in exec is invisible.** `TOOL_REJECT_REASON` (`shim.mjs:46`) has
exactly one occurrence in the tree — its own declaration. `#toToolCall` returns `null` for every
non-`mcpArgs` case and the run is torn down; the result is indistinguishable from a normal
completion. §6.4 and §6.11 both list exec rejection as a shim responsibility and §2.5 calls it
"the single most important design lesson from the port". Either port the small rejection table
(`index.js:3468-3520`) or amend the doc — do not leave them disagreeing.

**I14 — End-stream errors are swallowed.** `cursor-client.mjs:646` returns on the END_STREAM flag
without reading the payload, and `describeServerFrame` prints `endstream(0)` (`:472-473`). The
reference JSON-parses it and surfaces `code`/`debug`/`detail` (`index.js:3120-3136`). Every
Cursor-side failure — quota exhausted, model unavailable, auth revoked — reaches ZCode as an
empty 200 with `finish_reason: "stop"`.

---

### Improvements

- **Livelock watchdog missing.** `STREAM_PROGRESS_TIMEOUT_MS` is imported at
  `cursor-client.mjs:21` and never used; `#lastContent` is assigned at `:555` and `:648` and
  read nowhere. Only the 120 s idle clock exists, and any inbound frame — including Cursor's own
  heartbeat — resets it. A server that heartbeats but never sends content pins the response, the
  h2 session and a 5 s timer indefinitely. Track `#lastContent` on non-heartbeat frames and add
  the second check. This is what `#lastContent` was for.
- **Dead id and dead arithmetic.** `suffixStart` is initialised at `shim.mjs:206` and assigned at
  `:212`, never read. `ctx.conversationId` is stored (`shim.mjs:356`) and read back, but
  `buildRunRequest` mints a fresh `randomUUID()` every time (`conversation.mjs:208`). Delete
  both. Then fix the comment at `cursor-client.mjs:135-136` — "conversation_id is the
  server-native resumption anchor" is false, and `conversation.mjs:207` already says the
  opposite. That comment is what makes the whole id path look load-bearing.
- **Raw NUL byte in source.** `conversation-store.mjs:61` joins message hashes with a literal
  `0x00` (offset 2523, one NUL). `grep` reports "Binary file … matches" and returns no lines,
  which hid a call-site search during this review. Write `\u0000`; the hash is unchanged and the
  file stays text to every tool.
- **Ten constants with no reader.** Each has exactly one occurrence in the tree — its own
  definition: `PLUGIN_ID`, `USAGE_URL`, `USAGE_SUMMARY_URL`, `USAGE_TEAMS_URL`,
  `USAGE_AGGREGATED_URL`, `USAGE_TTL_MS`, `MAX_USAGE_MODELS`, `TOOL_CALL_SETTLE_MS`,
  `DEFAULT_CONTEXT_WINDOW`, `DEFAULT_MAX_TOKENS` (all `config.mjs`). The `cursor_usage` tool
  §6.5 plans for does not exist and nothing advertises it, so this is scope, not a defect — but
  delete or land them.
- **`auto_start` declared and ignored.** `.zcode-plugin/plugin.json:22` declares it; nothing
  reads it. Honour it or delete the key. (`port` is correctly wired.)
- **`modify()` returning `undefined` is papered over.** `auth.mjs:225` `?? next` reports a
  successful refresh for a token that was never written. Fall back only when `modify` actually
  persisted, or surface the loss.
- **Unbounded request bodies.** `shim.mjs:179` buffers with no cap and no `content-length`
  check; `Buffer.concat` doubles peak memory. One authenticated request can drive the shim to
  OOM. Reject on an oversized `content-length` and count bytes, aborting with 413.
- **The test seam sits exactly where the critical findings live.** `grep -n CursorShim
  test/conversation-store.test.mjs` returns nothing — the shim class is never instantiated. The
  checkpoint test at `:239-254` passes a throwaway `blobStore: new Map()` and asserts only that
  the state field equals the checkpoint, which is why C2 shipped green.

---

### Recommended approach

The architecture needs no change. It needs the two conversation mechanisms finished and the
wire layer made to match a schema it does not own. Smallest correct sequence:

1. **Make the wire layer literal.** C1, C4, C5 and I4 are all "we invented a protobuf reading
   instead of porting one". Port `decodeMcpArgs`, `decodeCheckpointUsedTokens`,
   `encodeExecClientMessage`/`Envelope` and the frame decompress cap verbatim from
   `dsh-cursor-subscription/lib/index.js`, and delete the pre-push at `cursor-client.mjs:557`.
   Every one of these is a copy-from-reference task, not a design task — which is the point:
   Cursor's protocol is not a place to be clever.
2. **Make the conversation state one record.** C2 and C3 are the same fix in two halves: the
   anchor that makes resumption legal is `{ checkpoint, blobs }` plus the rule *a turn that
   stopped on a tool call never becomes an anchor*. Both live in the store and `#commit`. No new
   abstraction — the store already holds one record per conversation and already has
   `forget`/`clear`/`max`/`ttl`.
3. **Make cancellation real.** I1 and I2 together are "respond while you work, and stop when
   told to". I2 is the higher-value half: streaming per-delta fixes TTFT, avoids the 600 s
   abort, and removes the 11-run retry amplification.

Order matters: 1 before 2, because a correct tool path is what makes the tool-call
invalidation in step 2 observable. Do not add a live exec bridge, a usage dashboard, or a
plugin/provider hook shim — §6.11's boundary is the feature and the defects here are all *inside*
it.

---

### Invariants

1. **A blob referenced by an anchored checkpoint is servable.** The blob closure is part of
   conversation state; it is persisted with the checkpoint and dies when it does.
2. **A checkpoint is only ever anchored if the run that produced it ended cleanly.** A run
   stopped on an unanswered exec is not resumable by a later turn, and the tool result it was
   waiting for must reach the model somehow — replay, not silence.
3. **The prefix hash is the only legitimacy test, and it covers only the prefix.** Any change to
   ZCode's system message or history forces a replay. It says nothing about suffix data, so it
   cannot be relied on to protect anything dropped after the anchor.
4. **Protobuf field numbers are copied, never derived.** If a number is not in the reference
   with a comment, it is wrong.
5. **The shim reports Cursor's accounting, never an estimate** — and a zero is a lie unless
   Cursor actually said zero. ZCode's compaction threshold is only as honest as this number.
6. **The shim never rewrites the message array.** No compaction, no pruning, no reordering, no
   "helpful" tidying. Every transformation must be byte-exact or not exist.
7. **Cursor's built-in execs are refused loudly.** Silence wedges a run and is indistinguishable
   from success.
8. **Exactly one live run per conversation.** Two concurrent runs against one checkpoint
   corrupt the anchor.
9. **Cancelling a ZCode turn cancels the Cursor run**, and the first byte is streamed before the
   run ends.
10. **The shim's only auth surface is loopback + a bearer key**, and every entry point resolves
    that key through one code path.

---

### Verification

**Re-verification of the criticals (all runnable offline):**

1. `decodeMcpArgs` — feed a canonical `McpArgs` built to `index.js:1516` and assert the return
   equals the reference's, with no throw. C1's probe is `/tmp/verify-review/probe2.mjs`.
2. Field numbers — assert `readFields(sendToolDefinitions(...))[0].field === 2` and that the
   pre-push no longer exists. Guards C4 against re-regression.
3. `decodeCheckpointUsedTokens` — assert a `{5:{1:41123}}` checkpoint returns `41123`. Guards C5.
4. **Two-turn shim test with a stubbed `AgentRun`** (the missing test, `test/` has no `CursorShim`
   coverage): turn 1 cold-starts and yields a checkpoint; turn 2 resumes and must still answer
   `get_blob_args` for the turn-1 root-prompt blob id with the **non-empty** system payload.
   That single assertion is C2. Assert additionally that a turn ending in an exec records **no**
   checkpoint — that is C3.
5. `frames()` — drive a real `AgentRun` against a local h2c server that streams 3 frames then
   `end()`s with no END_STREAM flag; assert it returns in well under a second. That is I3.

**Requires a live Cursor account (cannot be run here — no credentials in this environment):**

6. One real `cursor_login`, then one non-streaming `/v1/chat/completions` with a tool declared;
   assert the model returns a `tool_calls` finish and a non-empty `prompt_tokens`.
7. A real tool step: assert the follow-up turn's request bytes contain the tool result.
8. A real multi-turn session with a `grep_search`/`fetch_url` exec, to confirm C1's blast radius
   against production traffic and that field 10 actually arrives (the reference answering it is
   strong evidence, but it is inference, not something I measured).
9. The AI-SDK parser path: feed the captured SSE bytes to
   `@ai-sdk/openai-compatible@2.0.60` configured as ZCode configures it and assert
   `finishReason: "stop"` with intact usage. **Already fixed** in this revision — keep the
   regression test, since the usage frame is the one place the §6.11 accounting contract is
   enforced on the wire.

**Also worth running, and not run here:** the plugin's own suite
(`node --test test/conversation-store.test.mjs`). It passes today and would continue to pass
with C1–C5 all present, which is the finding about the suite, not about the code.
