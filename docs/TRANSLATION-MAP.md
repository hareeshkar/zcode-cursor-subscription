# The Cursor → ZCode translation map

Every agent, whatever the decade, is the same 30-year-old Unix toolkit wearing a
new interface: **read a file, write a file, search, list, run a command, fetch a
URL, diff, fork a helper**. Cursor's models call those primitives through
Cursor's own native tool execs. ZCode exposes the same primitives under its own
tool names and schemas. The shim's whole job is the column in between — one
contract, engineered once, and every repository underneath is just the workspace
the tools operate on.

```text
Cursor model
    ↓  native tool exec (agent.v1 protobuf)
Translator          ← this document's table
    ↓  host-shaped OpenAI tool call
ZCode tool schema   ← file_path, not path
    ↓
Real execution      ← under ZCode's permissions
    ↓
Your repository
```

Two rules make a translation first-class, and both are enforced in code
(`lib/translate.mjs`), not by prompting:

1. **Parameter names are the host's.** The host strips unknown keys before
   validating, so a wrong name is not a visible error — it is a call that
   arrives missing a required parameter and fails validation on every retry.
2. **A call that cannot pass validation is never emitted.** If a required field
   cannot be produced, the translation declines and the model is told which
   tools really exist.

The machine-readable version of this table is served live by the running shim
at `GET /internal/translation` — read that when you want what the code does
*today*; read this page for the reasoning.

---

## Translated — Cursor's native exec becomes a ZCode tool call

| Capability | Unix primitive | Cursor exec (wire field) | Cursor args → ZCode params | ZCode tool | Synthesized / dropped | Status |
|---|---|---|---|---|---|---|
| Read a file | `cat` / `read(2)` | `readArgs` (7) | `path`→`file_path`, `offset`→`offset`, `limit`→`limit` | **Read** | — (both sides are 1-based lines) | **live-verified** (grok, gpt-5.6-luna) |
| Read a file (redacted variant) | `cat` | `redactedReadArgs` (29) | same as `readArgs` (shares the schema) | **Read** | — | schema-tested |
| Search file contents | `grep(1)` / ripgrep | `grepArgs` (5) | `pattern`→`pattern`, `path`→`path`, `glob`→`glob`, `output_mode`→`output_mode`, `case_insensitive`→`-i`, `head_limit`→`head_limit`, `multiline`→`multiline` | **Grep** | `output_mode`'s string values match ZCode's enum exactly; unknown values dropped | schema-tested (flags); base path live |
| List a directory | `ls(1)` | `lsArgs` (8) | `path`→`path` | **Glob** | `pattern: "*"` synthesized (Cursor sends only a path) | schema-tested |
| Run a command | `sh(1)` | `shellArgs` (2) | `command`→`command` | **Bash** | — | **live-verified** |
| Stream a command | `sh \| tee` | `shellStreamArgs` (14) | `command`→`command` | **Bash** | — | **live-verified** (`git status` loop) |
| Run in background | `sh &` / `nohup` | `backgroundShellSpawnArgs` (16) | `command`→`command` | **Bash** | runs as a normal foreground call | schema-tested |
| Write a file | redirection / `tee` | `writeArgs` (3) | `path`→`file_path`, `file_text`→`content` | **Write** | — | schema-tested |
| Fetch a URL | `curl(1)` / `wget(1)` | `fetchArgs` (20) | `url`→`url` | **WebFetch** | `prompt` synthesized (required by the host, sent by no one) | schema-tested |
| Dispatch a subagent | `fork`/`exec` a helper | `subagentArgs` (28) | `subagent_type`→`subagent_type`, `prompt`→`prompt`, `run_in_background`→`run_in_background` | **Agent** | `description` synthesized (host-required); `model_id` dropped — the subagent runs on the host's configured model | schema-tested |
| Show a diff | `git diff` | `gitDiffRequestArgs` (44) | `cwd`/`ref`/`base_ref`/`merge_base`/`target_paths*`/`unified` → one synthesized, **shell-quoted** `git -C … diff …` command | **Bash** | still passes through ZCode's Bash permission system like any command | schema-tested |

### Cursor's "pi" tool family — a second numbering of the same primitives

Cursor's bundle carries a simpler parallel tool family (fields 45–51). Each maps
onto the same host tools with its own argument numbering.

| Capability | Cursor exec (wire field) | Cursor args → ZCode params | ZCode tool | Synthesized / dropped |
|---|---|---|---|---|
| Read a file | `piReadArgs` (45) | `path`→`file_path`, `offset`→`offset`, `limit`→`limit` | **Read** | — |
| Run a command | `piBashArgs` (46) | `command`→`command`, `timeout`→`timeout` (ms) | **Bash** | — |
| Edit by replacement | `piEditArgs` (47) | `path`→`file_path`, one edit's `old_text`→`old_string`, `new_text`→`new_string` | **Edit** | **single edit only** — a multi-edit request declines to the typed refusal rather than silently lose all but the first |
| Write a file | `piWriteArgs` (48) | `path`→`file_path`, `content`→`content` | **Write** | — |
| Search | `piGrepArgs` (49) | `pattern`, `path`, `glob`, `ignore_case`→`-i`, `context`→`context`, `limit`→`head_limit` | **Grep** | `literal` dropped — ZCode's Grep is regex-only |
| Find files by name | `piFindArgs` (50) | `pattern`→`pattern`, `path`→`path` | **Glob** | — |
| List a directory | `piLsArgs` (51) | `path`→`path` | **Glob** (falls back to `Bash ls -la`) | `pattern: "*"` synthesized |

**There is no native old/new edit exec in Cursor's main family.** Cursor's
models edit through full-file writes (`writeArgs`); ZCode's `Edit` is reachable
only through the pi variant above or the declared-tool path below.

---

## Passed through — the declared-tool channel

| Channel | What it is | What the shim does |
|---|---|---|
| `mcpArgs` (11) | The model calls a tool **by the host's declared schema** — every ZCode tool is registered with Cursor as a first-class tool, so the model can also just… call them. | Delivered verbatim: name, arguments (already host-shaped, model-authored), id sanitized. **Live-verified** across grok, composer, gemini, claude, gpt families. |
| `requestContextArgs` (10) | Cursor asks which tools exist. | Served: every host tool's JSON schema, both as protobuf Value and JSON text. This is the handshake that makes the channel above possible. |

---

## Refused — typed replies, never silence

Silence on an exec wedges the run, so every exec this build cannot translate
gets a typed reply on its own field. The model sees a legible error plus the
list of tools it *can* call, and the run continues.

| Cursor exec (wire field) | Why it is refused | Reply shape |
|---|---|---|
| `deleteArgs` (4) | No safe host delete tool. | `DeleteResult.rejected=6` `{path, reason}` |
| `diagnosticsArgs` (9) | LSP state belongs to the host. | empty `DiagnosticsResult.success` |
| `writeShellStdinArgs` (23) | No stdin stream to feed. | `WriteShellStdinResult.error=2` |
| `recordScreenArgs` (21), `computerUseArgs` (22) | No screen/computer access. | `McpResult.error` |
| `listMcpResourcesExecArgs` (17), `readMcpResourceExecArgs` (18) | MCP resources are the host's to expose. | `McpResult.error` |
| `shell/mcp/web_fetch_allowlist_precheck` (41/42/43) | The host's permission system **is** the allowlist. | flat `allowlisted = false` bool — the shape these expect, and the honest answer |
| `executeHookArgs` (27), `forceBackgroundShell/Subagent` (30/31), `mcpStateExecArgs` (36), `subagentAwaitArgs` (37), `smartModeClassifierArgs` (38), `canvasDiagnosticsArgs` (40), `miniSweAgentBash` (52), `conversationSearchArgs` (53), `agentStoreConflictArgs` (54), `adoptArgs` (56) | Cursor-internal machinery with no host counterpart. | generic `McpResult.error` on the exec's own field — proven (the field-36 case) to resume the run |
| anything newer | Cursor ships new variants without notice. | same generic reply, using the message's own field number so the run never hangs |

---

## The guarantees, in one place

| Guarantee | Where it lives |
|---|---|
| Only host-registered tool names are ever emitted | `translateBuiltinExec` name gate |
| Argument names follow the host's declared schema (alias picked per request) | alias tables in `lib/translate.mjs` |
| Required fields present or the call is refused | the required-field gate |
| Tool-call ids are control-character-safe (Cursor joins two ids with `\n`) | `sanitizedCallId` |
| Every translation is counted and logged (`translated` map, `translated built-in exec …`) | `/internal/status`, shim stderr |
| The live contract is inspectable | `GET /internal/translation` |
| Schemas in tests are ZCode's real ones, copied from `apps/zcode-cli/packages/contracts` | `test/exec-handling.test.mjs` fixture |
