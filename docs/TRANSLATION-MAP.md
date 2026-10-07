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

## The complete native inventory — every tool Cursor's bundle defines

One row per exec variant in `ExecServerMessage` (fields 2–56, from
cursor-agent 2026.10.01). **Handling** is what this shim does with it:
`→ Tool` means it becomes a ZCode tool call; anything else is a typed reply
that keeps the run alive.

| Cursor native tool | Field | What it does | Handling |
|---|---|---|---|
| `shell_args` | 2 | [Run a shell command] Execute one command synchronously and return stdout/stderr/exit code. | → `Bash` (`command`) |
| `write_args` | 3 | [Write a file] Create or overwrite a file with full contents (`path`, `file_text`). | → `Write` (`file_path`, `content`) |
| `delete_args` | 4 | [Delete a file] Remove a file from the workspace. | Refused: `DeleteResult.rejected=6` — no safe host delete |
| `grep_args` | 5 | [Search file contents] Regex search across files with output mode, case flag, head limit, multiline. | → `Grep` (flags incl. `case_insensitive`→`-i`) |
| `read_args` | 7 | [Read a file] Return a file's contents, optionally from a line offset for a line count. | → `Read` (`path`→`file_path`, `offset`, `limit`) |
| `ls_args` | 8 | [List a directory] Return a directory tree listing. | → `Glob` (`pattern: "*"` synthesized) |
| `diagnostics_args` | 9 | [Get code diagnostics] Ask for LSP errors/warnings on files. | Refused: empty success — LSP state is the host's |
| `request_context_args` | 10 | [Ask what tools exist] The handshake: server asks for tool schemas, rules, env. | Served: every host tool's JSON schema |
| `mcp_args` | 11 | [Call a registered tool] Invoke one of the MCP tools the client declared — the declared-tool channel. | Passed through verbatim (already host-shaped) |
| `shell_stream_args` | 14 | [Stream a shell command] Run a command and stream stdout/stderr events live. | → `Bash` (`command`) |
| `background_shell_spawn_args` | 16 | [Spawn a background shell] Start a long-running process (dev server, watch) addressable later. | → `Bash` (runs as a normal call) |
| `list_mcp_resources_exec_args` | 17 | [List MCP resources] Enumerate resources exposed by MCP servers. | Refused: `McpResult.error` |
| `read_mcp_resource_exec_args` | 18 | [Read an MCP resource] Fetch one MCP resource's contents. | Refused: `McpResult.error` |
| `fetch_args` | 20 | [Fetch a URL] Retrieve a web page. | → `WebFetch` (`url`; `prompt` synthesized — host-required) |
| `record_screen_args` | 21 | [Record the screen] Screen capture via accessibility APIs. | Refused: `McpResult.error` — no screen access |
| `computer_use_args` | 22 | [Drive the computer] Mouse/keyboard control of the desktop. | Refused: `McpResult.error` |
| `write_shell_stdin_args` | 23 | [Feed a shell's stdin] Write input to a previously spawned shell. | Refused: `error=2` — no stdin stream to feed |
| `execute_hook_args` | 27 | [Run a lifecycle hook] Execute a registered hook (pre-compact, stop, …). | Refused: generic error on own field |
| `subagent_args` | 28 | [Dispatch a subagent] Spawn a nested agent with its own type, model and prompt. | → `Agent` (`description` synthesized, `model_id` dropped) |
| `redacted_read_args` | 29 | [Read a file, redacted] Variant of read with server-side content redaction. | → `Read` (same schema; the host is the executor) |
| `force_background_shell_args` | 30 | [Background a shell] Move a running shell to the background. | Refused: generic — no host mechanism |
| `force_background_subagent_args` | 31 | [Background a subagent] Move a running subagent to the background. | Refused: generic |
| `mcp_state_exec_args` | 36 | [Poll MCP server state] Check whether MCP servers are alive. (Long misread as "provider routing" — its `server_identifiers` named our provider.) | Refused: generic (proven to resume the run) |
| `subagent_await_args` | 37 | [Await a subagent] Wait for a background subagent's result. | Refused: generic |
| `smart_mode_classifier_args` | 38 | [Classify the request] Internal smart-mode routing classifier. | Refused: generic |
| `canvas_diagnostics_args` | 40 | [Canvas diagnostics] Diagnostics for Cursor's canvas feature. | Refused: generic |
| `shell_allowlist_precheck_args` | 41 | [Precheck a command] "Is this command pre-approved?" before running it. | Answered: flat `allowlisted=false` — the host's permission system is the allowlist |
| `mcp_allowlist_precheck_args` | 42 | [Precheck an MCP call] Same, for tool calls. | Answered: `allowlisted=false` |
| `web_fetch_allowlist_precheck_args` | 43 | [Precheck a fetch] Same, for URL fetches. | Answered: `allowlisted=false` |
| `git_diff_request` | 44 | [Show a git diff] Structured diff request: cwd, refs, paths, context lines. | → `Bash` (synthesized, shell-quoted `git diff`) |
| `pi_read_args` | 45 | [Read a file] Pi family: same primitive, simpler args. | → `Read` |
| `pi_bash_args` | 46 | [Run a command] Pi family, with a timeout field. | → `Bash` (`timeout` carried) |
| `pi_edit_args` | 47 | [Edit by replacement] One file, a list of `{old_text, new_text}` replacements. | → `Edit` for a single replacement; multi-edit refused rather than lose all but the first |
| `pi_write_args` | 48 | [Write a file] Pi family. | → `Write` |
| `pi_grep_args` | 49 | [Search file contents] Pi family, with ignore-case, context and limit. | → `Grep` (`ignore_case`→`-i`, `literal` dropped) |
| `pi_find_args` | 50 | [Find files by name] Pi family pattern search. | → `Glob` |
| `pi_ls_args` | 51 | [List a directory] Pi family. | → `Glob` |
| `mini_swe_agent_bash_args` | 52 | [Mini-agent bash] Empty-args bash for Cursor's mini SWE-agent. | Refused: generic |
| `conversation_search_args` | 53 | [Search past chats] Query the user's conversation history. | Refused: generic |
| `agent_store_conflict_args` | 54 | [Resolve a store conflict] Internal agent-store reconciliation. | Refused: generic |
| `adopt_args` | 56 | [Adopt a session] Take over another agent's session/state. | Refused: generic |

Unassigned fields in 1–56: 1, 6, 12, 13, 15, 24–26, 32–35, 39. Anything new
Cursor ships lands in the last row's handling automatically: a generic typed
reply on the message's own field, so the run never hangs.

## The other side — ZCode's native tools we translate onto

These are the "old native" tools: the primitives every harness has exposed
since the Unix days, under ZCode's own names and schemas. The first eight are
translation targets; the rest of the host toolbox is reachable through the
declared-tool channel (`mcp_args`).

| ZCode tool | What it does | Schema facts that matter |
|---|---|---|
| `Read` | [Read a file] Contents with 1-based line offset/count, line numbers, 2,000-line default cap. | `file_path` **required**; `offset`/`limit` optional ints; rejects binary/device paths |
| `Write` | [Write a file] Create or overwrite with full contents. | `file_path` + `content` both **required** |
| `Edit` | [Replace text in a file] Exact string replacement, optional replace-all. | `file_path`, `old_string`, `new_string` all **required**; `replace_all` default false |
| `Bash` | [Run a shell command] One command, captured output, optional timeout/background/sandbox escape. | `command` **required**; `timeout` ≤ 600,000 ms; schema is **strict** — unknown keys rejected |
| `Grep` | [Search file contents] Ripgrep with output modes and flags. | `pattern` **required**; `output_mode` enum `content\|files_with_matches\|count` (default `files_with_matches`); `-i`, `glob`, `head_limit` (default 250), `context` |
| `Glob` | [List files by pattern] Glob-based file listing — the only listing tool. | `pattern` **required**; `path` optional |
| `WebFetch` | [Fetch a URL and answer about it] Retrieves the page and answers a prompt against it; cached 15 min. | `url` + `prompt` both **required** |
| `Agent` | [Dispatch a subagent] Spawns a nested agent with its own context and tool profile. | `description` + `prompt` **required**; `subagent_type` free string; `run_in_background` |

The rest of the host toolbox, one line each — all reachable via the declared-tool channel:

| ZCode tool | What it does |
|---|---|
| `WebSearch` | [Search the web] Query (min 2 chars), domain allow/block lists; strict schema |
| `TodoRead` / `TodoWrite` | [Task list state] Read / replace the session's todo list |
| `TaskOutput` | [Read a task's output] Background shell/agent output (aliases `BashOutput`, `AgentOutput`) |
| `TaskStop` | [Kill a task] Stop a background shell/agent (aliases `KillShell`, `KillBash`) |
| `Skill` | [Invoke a skill] Run a registered slash-command skill |
| `AskUserQuestion` | [Ask the user] Structured multiple-choice question |
| `EnterPlanMode` / `ExitPlanMode` | [Plan] Switch to read-only planning / present a plan for approval |
| `CronCreate` / `CronUpdate` / `CronList` / `CronDelete` | [Schedule work] CRUD for scheduled automations |
| `SendMessage` / `RespondToCoordinator` | [Agent-to-agent messaging] Coordinate with sibling agents |
| `ListModels` | [List providers] The host's model inventory |
| `js` | [Node REPL] Evaluate JavaScript (browser/computer-use support) |
| Workflow family | [Dynamic workflows] Create/amend/run workflow scripts (gated) |

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
