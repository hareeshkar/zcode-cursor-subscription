# Concepts, protocol and host contracts

A reference for anyone working on this plugin. It answers three questions that
took the longest to get right — **what is a conversation, what is a resume, what
is a token** — and then records the two wire contracts the plugin sits between:
Cursor's protocol below it, and ZCode's host behaviour above it.

Everything here is derived from source or from live capture, and each claim says
which. Where something is unverified, it says so rather than implying more.

---

## Part 1 — The three concepts

### What is "a conversation"?

Not this plugin's idea. **Cursor holds a conversation on its servers.** When a
run starts, you send it state; when the run ends, Cursor returns a
**checkpoint** — an opaque serialized blob describing everything it now holds.

The checkpoint is the conversation. It is the thing worth keeping, because the
alternative is re-sending the entire history as text every turn.

The shim stores it in `ConversationStore`, keyed by a hash of the message array it
corresponds to. `conversationId` is a fresh UUID per run and is *not* the anchor —
the checkpoint is. A `cursor_status` reading of `conversations: 1` means one
anchored conversation is available to resume.

### What is "a resume"?

Sending Cursor only the new turn, because it already holds the rest.

It is only safe when the incoming message list is an **exact extension** of what
was committed. ZCode rewrites history constantly — auto-compaction,
microcompaction, an edit, a rewind, a branch — and resuming across any of those
would leave Cursor reasoning about messages the user can no longer see, with no
error anywhere.

So every turn runs a prefix check (`planTurn`):

| Condition | Decision | Why |
|---|---|---|
| Incoming is the committed list plus a suffix | **resume** | Cursor holds a valid prefix |
| History shrank | **replay** | compaction, branch, or a rewound session |
| Any prefix message differs by hash | **replay** | a turn was edited or regenerated |
| A tool call is in flight | **no anchor** | the checkpoint is paused mid-tool; resuming would drop the tool result the host is about to send |

The prefix is compared by **content hash**, never by position or id, and the hash
is over content only — no timestamps, no request ids. Anything per-request in
that hash would change every turn and silently defeat resumption.

`cursor_status` reports the **resume rate**: the share of turns that reused
Cursor's context. That is the honest metric. Cursor exposes no cache-hit telemetry
to third-party clients, so a "cache hit rate" cannot be claimed.

**Why it matters:** a resume costs the tokens of the new turn. A replay costs the
tokens of the entire history, every turn. For a long session that is the
difference between linear and quadratic cost.

### What is "a token"?

Two different things, and conflating them causes real bugs.

**Completion tokens** arrive during the run as `tokenDelta` interactions. The shim
sums them.

**Prompt tokens** — the input count — arrive in the **checkpoint**, in
`token_details`. This is the number that matters most, because **ZCode derives its
compaction threshold from it**. Report zero and compaction never fires on real
usage; the context grows until something else breaks.

The path, **verified against a live capture** rather than argued:

```
checkpoint → field 5 (token_details) → field 1 (used_tokens, varint)
```

A real checkpoint from a second turn decoded as:

```
TokenDetails.field 1 = 10985    used tokens
TokenDetails.field 2 = 200000   the context window
TokenDetails.field 3            a per-section breakdown, `system_prompt` visible in it
```

Field 5 is empty on the very first minimal checkpoint and populated from the
second turn onward — there is nothing to count yet. A checkpoint with no token
details returns `undefined`, never a fabricated `0`, because `0` tells the host
the context is empty.

The shim reports Cursor's own accounting and never estimates. A guessed token
count would make the host compact at the wrong time.

---

## Part 2 — Cursor's protocol, below the plugin

Undocumented, reverse-engineered, and known to change without notice.

**The authoritative field maps are in [`CURSOR-PROTOCOL-SCHEMA.md`](./CURSOR-PROTOCOL-SCHEMA.md)**,
extracted from Cursor's own client bundle. This part is the guided tour; that file
is the reference. Field
numbers are the fragile part: a wrong number is worse than a missing feature,
because the message is accepted and silently does nothing.

### Message families

| Message | Fields |
|---|---|
| `AgentRunRequest` | `conversation_state=1`, `action=2`, `model_details=3`, `conversation_id=5` |
| `ConversationState` | `root_prompt_messages_json=1` (repeated blob id), `turns=8` |
| `ModelDetails` | `model_id=1`, `display_model_id=3`, `display_name=4`, `display_name_short=5`, `aliases=6` |
| `UserMessageAction` | `user_message=1`, `conversation_history=7` |
| `ConversationHistory` | `messages=1` (each a `HistoryMessage.user=1`) |
| `UserMessage` | `content=1`, `message_id=2` |
| `UserContent` | `image=2` |
| `ConversationHistoryImageContent` | `data=1` (raw base64), `mime_type=2` |
| `RequestContext` | `tools=7` (`McpToolDefinition`) |
| `McpToolDefinition` | `name=1`, `description=2`, `input_schema=3`, `provider_identifier=4`, `tool_name=5` |
| `AgentClientMessage` | `run_request=1`, `exec_client_message=2`, `client_heartbeat=7` |

**We write `ModelDetails` fields 1, 3 and 4** — all set to the model id. Fields 5
and 6 exist on the wire and are read by the reference implementation but written
by neither; they are presentational (a short display name, aliases).

**`ConversationState.turns=8` is effectively dead.** The reference documents why:
*"Never hand-encode field-8 turns: current Cursor servers treat them as blob ids."*
We pass `turns: []` unconditionally, matching.

### The exec channel

One server message type carries several unrelated meanings. **Misreading it is
what silently disabled tool calling for the life of this project.**

| Field | Meaning | Correct handling |
|---|---|---|
| `10` `request_context_args` | "send me your tool schemas" | answer with `RequestContext.tools`, continue |
| `11` `mcp_args` | **the actual tool call** | end the run, hand it to the host |
| `2,3,4,5,7,8,9,14,16,17,18,20,21,22,23` | Cursor's own filesystem, shell and screen tools | refuse on the exec's own field, continue |
| `36` | unknown; appeared recently | refuse on its own field, continue |

**The rule: only `mcp_args` ends a run.** Everything else is answered — on the
exec's *own* field number, because the server routes the reply by that slot.
Silence does not mean "no"; it means the run waits forever. That is what made
`read_file` hang while `get_weather` worked.

Two consequences worth knowing:

- **Refusals are about to be generic.** We send one `McpResult.error` shape for
  every refused tool. The reference sends *typed* rejections per exec
  (`ReadResult.rejected`, `ShellResult.rejected`, …). Ours works — the run
  resumes either way — but the model cannot distinguish "permission denied" from
  "unsupported". Tracked in the audit.
- **Unknown exec variants must stay unknown.** Do not hardcode field 36. Preserve
  the number and reply into its slot; that is what lets a variant newer than this
  build be refused gracefully instead of stalling.

### Thinking effort is not a field

There is no thinking, reasoning or budget field on `ModelDetails` or `RunRequest`
in any of the three implementations examined. **Effort is carried in the model
id**: `grok-4.7-high-fast`, `claude-4.5-sonnet-thinking`, `composer-2.5-fast`.

That is why the account exposes each effort level as a *separate model*, and why a
reasoning-level selection made in the UI cannot be transmitted. The shim reports
it as an approximation rather than pretending.

Thinking does appear as an **output**: `InteractionUpdate.thinking_delta=4` and
`thinking_completed=5`. We map the former to `reasoning_content`.

### Images: encoded correctly, not delivered

The encoding is verified correct and byte-identical to the reference:
`data=1` raw base64, `mime_type=2`, four levels of nesting, attached to the
action at `UserMessageAction.conversation_history=7`.

**The model never receives them.** Evidence, all live:

| Test | Result |
|---|---|
| Synthetic 64×64 solid-colour PNG, 5 models across 4 families | each replied "I don't see any image" |
| Real screenshot (a booking screen with legible text), Gemini | no image; the model then ran `grep` and `shell` execs looking for it |
| Same screenshot at 150 px | request opened, streamed, produced no usable reply |

The encoding was separately proven present in the outgoing bytes — payload and
field-7 tag both confirmed in the encoded request. So the loss is on Cursor's
side, not ours.

Two hypotheses remain untested, and are recorded as such rather than as
conclusions:

1. The image may need to be in the *history* rather than the action. The field is
   named `conversation_history`, yet both implementations populate it with the
   *current* message's images.
2. There may be an undeclared request-side capability flag. Neither `ModelDetails`
   field 2 nor the gaps at exec fields 6, 12 and 13 have any known meaning.

**Resolved — and it was never our bug.** Cursor's `AvailableModel` declares
capabilities per model, including `supports_images`. Queried live, **all 241
models on this account report no image support**, as does `supports_thinking` and
`context_token_limit`. The encoding was correct against Cursor's own schema; the
API simply does not offer the capability.

So models are advertised as `supportsImage: false`, and that is now **read from
Cursor** rather than being a blanket constant — a model that did declare support
would get it automatically. The host substitutes placeholder text for an image,
which gives the user a clear signal instead of a model that flails and stalls.

---

## Part 3 — ZCode's host behaviour, above the plugin

What ZCode sends, and what happens to it, read from its source.

### The system prompt is up to three messages plus reminder attachments

`ContextBuilder.build()` emits, in order:

1. a `cli_prefix` system message ("You are ZCode, an interactive coding agent"),
2. a stable body — identity and `# Harness` rules,
3. a dynamic block — environment, session guidance, memory, output style,
   compaction policy, git status,
4. then meta-user attachments rendered as **user** messages wrapped in
   `<system-reminder>`: the skills listing, and AGENTS.md/user instructions.

**There is no `developer` role.** The union is
`system | user | assistant | tool`.

**For `openai-chat-completions` the leading system messages are joined into one**
with `join("")` — no separator. So by the time the shim sees it, the prompt is one
string, and `collectSystemText` publishes it as a SHA-256-keyed blob that Cursor
fetches back.

Tool descriptions are **not** in the system prompt. They travel in the request's
`tools` field, which is why the shim registers them per-run rather than assuming
they are restated.

### Steering arrives as a user message, not a turn

When the user types while a turn is running, ZCode appends a *request-only*
attachment rather than a new conversation turn, rendered as:

```
The user sent a new message while you were working:
<body>

This is how ZCode surfaces messages the user sends mid-turn — within the running
turn, often alongside the next tool result, rather than as a separate conversation
turn. Address the message above as you continue this turn.
```

For the shim this is an ordinary user message, and it passes through unchanged.
There is no mechanism to edit an already-sent historical message — history is
append-only, and corrections happen by steering.

### Compaction rewrites history, in two different ways

| Mechanism | Effect |
|---|---|
| **Compaction** (auto, reactive, `/compact`) | Whole earlier rounds are replaced by a **summary carried as a user message**. The original messages are gone from the active history |
| **Microcompaction** (every roundtrip, and after 60 min idle) | Old tool results are rewritten **in place** to the literal string `"[Old tool result content cleared]"`, keeping role and ids — except media-bearing and error results, which are left alone |

Both matter enormously to the resume check, because both change the message array
at arbitrary depth. The prefix hash sees it and forces a replay. That is the
design working, not a problem.

### Tool results are textified for this protocol

For `openai-chat-completions`, structured tool results are converted to text, and
any images *inside* a tool result are moved out into a synthetic follow-up user
message beginning `"Tool result media from <toolName>:"`. An error result becomes
`{type:"error-text"}`.

Other placeholders worth recognising in a transcript:
`"[Tool execution was interrupted before resume]"`, `"[Old tool result content
cleared]"`, and `"empty_tool_name"`.

### Every request field, and what the shim does with it

Always present: `model`, `messages`, `stream: true`,
`stream_options.include_usage`, `tools`.

| Field | Shim behaviour |
|---|---|
| `tools` | registered with Cursor per run, as `McpToolDefinition` |
| `tool_choice: "none"` | no tools registered — a host told "none" that still gets a tool call has been lied to |
| `tool_choice: {function:{name}}` | only that tool registered; a named choice is a filter, not a hint |
| `tool_choice: "required"` | **not expressible**; reported, because the model may still answer in prose |
| `response_format: json_object` / `json_schema` | folded into the system prompt as an instruction, and declared as the best effort it is |
| `reasoning_effort`, `thinking`, `enable_thinking`, `reasoning` | **not expressible** — effort lives in the model id; reported |
| `max_completion_tokens` | **not expressible**; reported |
| `temperature`, `top_p`, `stop`, `seed`, penalties | **not expressible**; reported |

The last four rows are written by ZCode's **option map**, which patches the JSON
body by intercepting `fetch` — not by its SDK. That is exactly why they are easy
to miss: they never appear in a type.

`parallel_tool_calls` and `user` are never sent by ZCode, and `maxRetries` is 0 —
ZCode owns retries.

### The streaming contract

- Every SSE frame must carry a **`choices` key**, including the usage-only frame
  (`choices: []`). Omitting it makes the host's parser emit a validation error and
  finalise the turn as `finishReason: "error"`, discarding the usage even though
  the text already streamed.
- A turn finalises on a `finish` chunk. A **zero-output** completion is retried
  once, and otherwise surfaces as an invalid-response error — which is why usage
  is always emitted.
- Idle timeout is **600 s**, with a retry budget of 11 attempts. **Retry is
  impossible once output has been emitted**, so a late failure goes to the host's
  stream recovery instead.
- The host also parses SSE frames itself to detect business errors inside an HTTP
  200: `success: false`, a non-zero `code`/`error_code`/`providerCode`, or an
  `event: error` frame. The shim must not emit those keys on success.

**Never retry a failed Cursor run automatically.** The streaming protocol cannot
prove a failed attempt was not processed remotely, so a retry can duplicate work
and spend the user's quota.

### Cancellation

The host's `abortSignal` reaches the shim as an aborted HTTP request. The provider
side has one obligation: stop and release. No acknowledgement is expected.

---

## Part 4 — What is still open

Recorded so nobody has to rediscover it.

| Item | State |
|---|---|
| Image delivery | **Closed.** Cursor declares `supports_images` false for all 241 models on this account. The encoding is correct; the capability is not offered |
| Structured history | The protocol has typed user/assistant/tool messages, tool calls and reasoning. We replay as a text transcript. Largest known fidelity gap — see the schema doc |
| Typed exec rejections | Generic refusal works; per-tool reasons would let the model distinguish failures |
| Parallel tool calls | Unverified; the run ends at the first call |
| Inter-chunk stall watchdog | Not built. A first-token timeout does not bound a long-lived HTTP/2 stream |
| Model display names | `ModelDetails` 5/6 are read by the reference, written by neither |
| `thinking_completed.durationMs` | Server sends it; we discard it |
| Type-check burn-down | 83 diagnostics remain, mostly `any` on dynamic objects. Null-safety is clean and blocking |

---

## Sources

| Area | Source |
|---|---|
| Cursor field maps | `lib/cursor-client.mjs`, `lib/proto.mjs`, cross-checked against `dsh-cursor-subscription/lib/index.js` and `auth2api-ref/src/upstream/cursor-api.ts` |
| Token path | live checkpoint capture, decoded — see Part 1 |
| Host config schema | `ZCode/packages/provider/src/config/provider-data-schema.ts`, `resolver.ts` |
| Host context assembly | `ZCode/apps/zcode-cli/packages/core/src/context/builder.ts`, `runtime/helpers/provider-request-messages.ts` |
| Steering, compaction | `runtime/methods/steering.ts`, `compact/microcompact.ts`, `compact-active.ts` |
| Streaming, retries, cancellation | `adapters/src/model/runner-*.ts`, `contracts/src/config/index.ts` |
| Option map | `packages/model-option-map/`, `adapters/src/model/model-option-map-fetch.ts` |
| Provider mapping | [`ZCODE-PROVIDER-MAPPING.md`](./ZCODE-PROVIDER-MAPPING.md) |
| Defects found | [`HARNESS-AUDIT.md`](./HARNESS-AUDIT.md) |
