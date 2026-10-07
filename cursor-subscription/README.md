# Cursor Subscription for ZCode

Use a Cursor subscription as a **first-class ZCode model provider**. Cursor models appear in the model
picker and behave like any other ZCode model: your own tools, your own permission prompts, ZCode's own
context management and compaction.

```mermaid
flowchart LR
    Z["ZCode<br/>model picker, tools,<br/>permissions, compaction"]
    S["Local shim<br/>127.0.0.1:8477<br/>OpenAI → Cursor"]
    C["api2.cursor.sh<br/>Connect-RPC + protobuf"]
    Z -- "POST /v1/chat/completions<br/>SSE" --> S
    S -- "HTTP/2, protobuf" --> C
    C -- "streamed reply" --> S
    S -- "text + tool_calls" --> Z
    Z -- "tool result" --> S
```

The shim never executes a tool. When Cursor asks for one, the shim ends the run with
`finish_reason: "tool_calls"`, so **ZCode** runs the tool under **ZCode's** permission system.

## Setup — one command

```
/connect-cursor-and-initialize
```

That single call does the whole thing:

1. adopts the Cursor session already on this machine — no browser, no second sign-in
2. proves it can answer, with a real completion on a few cheap models
3. creates the provider entry in ZCode's config
4. publishes every model your account can use

There is nothing to paste into Settings. Quit ZCode (⌘Q) and reopen it, then pick a model.

If you have **no local Cursor install**, the browser PKCE flow (`cursor_login`) is used instead. The
agent only falls back to it when no local session is found.

## How it works

ZCode speaks `openai-chat-completions` to providers. Cursor's agent protocol is protobuf over
bidirectional HTTP/2. A small local shim translates between the two and binds loopback only.

### Tool calling — one contract, every repository

Cursor's models natively call their own file/shell tools (`readArgs`, `grepArgs`, `shellArgs`, …).
The shim translates each one into the matching ZCode tool **with the host's parameter names**, so
nothing depends on the repository underneath:

| Capability | Cursor native | → ZCode tool | Key argument renames |
|---|---|---|---|
| Read a file | `readArgs` | `Read` | `path` → `file_path` (+ `offset`/`limit`) |
| Write a file | `writeArgs` | `Write` | `path` → `file_path`, `file_text` → `content` |
| Search | `grepArgs` | `Grep` | `case_insensitive` → `-i`, flags match |
| List | `lsArgs` | `Glob` | `pattern: "*"` synthesized |
| Run a command | `shellArgs` / `shellStreamArgs` | `Bash` | `command` → `command` |
| Fetch a URL | `fetchArgs` | `WebFetch` | `prompt` synthesized (host-required) |
| Subagent | `subagentArgs` | `Agent` | `description` synthesized, `model_id` dropped |
| Edit | `piEditArgs` (single edit) | `Edit` | `old_text` → `old_string`, `new_text` → `new_string` |
| Diff | `gitDiffRequestArgs` | `Bash` | synthesized, shell-quoted `git diff` |

Every ZCode tool is *also* registered with Cursor as a first-class tool, so models can call them
directly by the host's own schemas. Two guarantees hold on the translation path: arguments always
match the host's declared schema (a wrong parameter name is not an error you can see — it is a call
that fails validation on every retry), and a call that cannot satisfy the host's required fields is
refused with a legible typed reply instead of emitted and doomed. Execs with no host counterpart
are refused the same way — never left unanswered, which would hang the run.

The full table — every exec variant Cursor's bundle defines, including its second "pi" tool family,
what is translated, passed through, or refused and with which typed reply — lives in
[`docs/TRANSLATION-MAP.md`](../docs/TRANSLATION-MAP.md). The machine-readable contract is served
live by the running shim at `GET /internal/translation`, and `/internal/status` counts translations
per exec case, so you can always see which path a turn actually took.

### Context and cost

ZCode owns the conversation and rewrites it between turns — auto-compaction, microcompaction, edits and
branches all change history. So the shim does not blindly resume a server-side Cursor conversation;
that would leave Cursor reasoning about messages you can no longer see, with no error anywhere.

Instead it records what it committed to Cursor and checks, every turn, whether your messages are an
**exact extension** of that:

| | Cost |
|---|---|
| Exact extension | Resume the server-side conversation, send only the new turn |
| Anything changed | Full replay |

Because the check is against the whole prefix, every operation that rewrites history automatically
forces a replay. The worst case is exactly what a replay-only design would cost, and never worse.

`cursor_status` reports the **resume rate** — the share of turns that reused Cursor's context. That is
the number worth watching. Cursor does not expose cache-hit telemetry to third-party clients, so a
"cache hit rate" is not something this plugin can honestly claim.

### Ports

The shim prefers port `8477` and **records the port it bound**. If something else already holds it and
is not one of ours, it moves to the next free port rather than failing. Two ZCode sessions is a normal
case: the second adopts the port the first is serving instead of starting a duplicate, and takes it
over if the first exits. `cursor_doctor` probes the socket rather than trusting that decision, so a
dead port is reported as dead.

## Commands

| Command | Purpose |
|---|---|
| `/connect-cursor-and-initialize` | **Start here.** Connects, verifies, creates the provider and registers every model |
| `/cursor-status` | Sign-in state, token expiry, shim health and resume rate |
| `/cursor-models` | List the models your account can use, without changing anything |
| `/uninstall-cursor-and-plugin` | Remove the plugin completely so a reinstall starts clean |

## Tools

| Tool | Purpose |
|---|---|
| `cursor_connect_and_initialize` | The whole onboarding in one call |
| `cursor_doctor` | Read-only: session, shim and provider entry — and whether they agree |
| `cursor_import` | Adopt the session from a local Cursor install — no browser needed |
| `cursor_login` | Browser PKCE sign-in, for machines without Cursor installed |
| `cursor_selftest` | A real tiny completion on several auto-picked cheap models |
| `cursor_register_models` | Write the discovered models into ZCode's provider config |
| `cursor_status` | Sign-in state, token expiry, shim health and resume rate |
| `cursor_models` | List the models your account can use |
| `cursor_logout` | Delete the stored credential, keeping the plugin installed |
| `cursor_uninstall` | Remove the plugin, its config, and the cached model list |

## Safety

- Credentials are written `0600` in a `0700` directory, atomically, with a compare-and-swap so two
  concurrent runs cannot clobber each other's token refresh.
- No token ever appears in a tool response, a log line, an error message or the skill.
- The shim binds loopback only and rejects unauthenticated requests in constant time.
- **Nothing happens on install.** No network call is made until you sign in.

## ⚠️ Please read

Cursor's agent protocol is **undocumented and reverse-engineered**. It can stop working without notice
when Cursor changes its servers or client version.

Relaying a consumer subscription through a third-party client is exactly the activity most likely to
trip Cursor's account protections. Use it for your own local work, and do not redistribute it or use it
to serve other people. You are shown this notice before signing in.

Not affiliated with or endorsed by Anysphere.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Provider 401 | The API key in ZCode does not match the one the plugin wrote |
| Connection refused | Shim not running, or the provider's Base URL and the shim's port disagree — `cursor_doctor` names it |
| `cursor_doctor` says the ports disagree | The shim moved ports; re-run `cursor_connect_and_initialize` to bring the entry back in step |
| Cursor turn fails with `CURSOR_ERROR` | Cursor changed the protocol or client version |
| Tool calls do nothing | Cursor asked for one of its own built-in tools; the shim refuses those by design |
| Sign-in times out | The browser flow was not completed; polling waits about 2.5 minutes |
| `cursor_import` fails | Cursor is installed but not signed in — open Cursor and sign in there first |

**Do not retry a failed run automatically.** Cursor's streaming protocol cannot prove a failed attempt
was not processed remotely, so a retry can duplicate work and burn your quota.

## Credits

Built on **[dsh-cursor-subscription](https://github.com/orrinzeng/dsh-cursor-subscription)** by
orrinzeng (MIT), which does the same thing for DeepSeek Harness. `proto.mjs`, `auth.mjs` and
`cursor-client.mjs` are derived from it; everything else here is new. See
[`NOTICE.md`](./NOTICE.md) for the per-file derivation, and [`LICENSE`](./LICENSE).

## Request controls

ZCode can send request parameters Cursor's run request has no field for. Rather
than dropping them, each is either honoured by construction or reported:

| Host sends | What happens |
|---|---|
| `tool_choice: "none"` | No tools are registered — a host told "none" that still receives a tool call has been lied to |
| `tool_choice: {function: {name}}` | Only that tool is registered; the rest would let the model pick what the host ruled out |
| `tool_choice: "required"` | Not expressible; reported, because the model may still answer in prose |
| `parallel_tool_calls: false` | Honoured — the run already ends at the first tool call |
| `response_format: json_object` / `json_schema` | Folded into the system prompt as an instruction, aiming the model at the schema |
| `temperature`, `top_p`, `stop`, `seed`, penalties | Named as inexpressible rather than silently ignored |

`cursor_doctor` lists any approximation a session has used, so the difference
between "the shim is broken" and "the shim is approximating, and here is exactly
where" is visible in one call.

## Development

```sh
node --test test/*.test.mjs          # 118 unit tests, no quota
CURSOR_LIVE_TESTS=1 node test/live-structured.mjs [baseUrl]   # the replay matrix
CURSOR_LIVE_TESTS=1 node test/live-roundtrip.mjs [models]
CURSOR_LIVE_TESTS=1 node test/live-conversation.mjs [model]
node test/sad-paths.mjs              # malformed input; one real completion
```

The live probes spend real quota and refuse to run unless `CURSOR_LIVE_TESTS=1`. They exist because
the biggest defect in this project was invisible to unit tests: every layer encoded correctly and
tool calling still did nothing. See [`docs/HARNESS-AUDIT.md`](../docs/HARNESS-AUDIT.md).

`CURSOR_SHIM_DEBUG=1` prints every frame kind, every exec case and the raw bytes of each exec. It is
what turns "the tool call does not fire" into a specific unknown field number in one run.

The research dossier — protocol field maps, host contracts, the alternatives considered and why they
were rejected — is in [`docs/RESEARCH-FINDINGS.md`](../docs/RESEARCH-FINDINGS.md). The adversarial
review that shaped the protocol code is in
[`docs/REVIEW-REPORT.md`](../docs/REVIEW-REPORT.md).
