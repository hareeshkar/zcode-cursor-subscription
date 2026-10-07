# The authoritative protocol schema

Extracted from **Cursor's own client** — the `cursor-agent` CLI that ships with
the Cursor app, at
`~/Library/Application Support/Cursor/User/globalStorage/anysphere.cursor-agent-worker/agent-cli/.local/share/cursor-agent/versions/<version>/index.js`.

This is ground truth, not inference. Every other source in this repository is a
port or a reimplementation; this is the thing they are ports *of*. When a field
number is in doubt, check here first.

The bundle declares each message's schema in a `static $()` that protobuf-es
consumes, so it can be read directly:

```sh
grep -o 'static \$(){return\["[^"]*"\]}' index.js
```

Field notation below is Cursor's own: `name <field-number> <kind>`, where `9` is a
string, `8` a bool, `5` an int32, `13` a uint32, `12` bytes, `4` a fixed64, `3` an
int64, and `#n` a nested message type. `*` means repeated, `?` optional.

---

## The run request — and three fields we were not sending

```
AgentRunRequest|1 conversation_state #0|2 action #1|3 model_details #2
  |9 requested_model #3?|4 mcp_tools #4|5 conversation_id 9?|6 mcp_file_system_options #5?
  |7 skill_options #6?|8 custom_system_prompt 9?|10 suggest_next_prompt 8?
  |11 subagent_type_name 9?|12 exclude_workspace_context 8?|13 harness 9?
  |14 selected_subagent_models #3*|15 selected_subagent_model_details #2*
  |16 conversation_group_id 9?|17 pre_fetched_blobs #7*|18 dev_raw_model_slug 9?
  |19 client_supports_inline_images 8?|20 subagent_model_overrides #8*
  |21 can_create_cloud_subagents 8?|22 suppress_subagent_progress_update_tool 8?
  |23 client_supports_send_to_user 8?|24 computer_use_coordinate_mode 9?|25 run_id 9?
  |26 agent_session_id 9?|27 client_supports_prompt_context_usage_rpc 8?
  |28 client_supports_routed_model_update 8?|29 system_prompt_spec #9?
  |30 client_llm_gateway_credential #10?|31 client_supports_preview_card 8?
  |32 started_as_new_project 8?|33 first_project_onboarding 8?
```

**`4 mcp_tools` — tools are declarable up-front.** Cursor's own client does exactly
that:

```js
new AgentRunRequest({
  conversationState: …,
  action: …,
  modelDetails: …,
  mcpTools: new Or({ mcpTools }),   // ← tools on the request itself
  …
})
```

This plugin learned tool calling the hard way: the model asks for schemas via a
`request_context_args` exec, and the shim replies on that exec's own field. That
path is proven. Declaring the tools here as well is what the native client does,
needs no round-trip, and is now sent alongside — the server may read either, and
this is not documented.

```
McpTools|1 mcp_tools #0*
```

**`19 client_supports_inline_images` — a capability flag for images.** Previously
never sent. It is the best candidate explanation for why a correctly-encoded
image was never seen by any model: a server has no reason to surface an inline
image to a client that has not said it can handle one. Now set when, and only
when, the request actually carries an image.

**`8 custom_system_prompt` — a first-class system prompt field.** We publish the
harness prompt as a SHA-256-keyed blob referenced from `conversation_state`
instead. That works and is proven; this field is the native alternative, and is
recorded here rather than adopted blind.

Also present and unused by us: `7 skill_options`, `13 harness`,
`29 system_prompt_spec`, `17 pre_fetched_blobs`, `27 client_supports_prompt_context_usage_rpc`.

---

## Models, tools and thinking

```
ModelDetails|1 model_id 9|3 display_model_id 9|4 display_name 9|5 display_name_short 9
  |6 aliases 9*|2 thinking_details #0?|7 max_mode 8?|8 api_key_credentials #1
  |9 azure_credentials #2|10 bedrock_credentials #3
```

`2 thinking_details` **does** exist, and the nested type is declared with no
fields:

```
ThinkingDetails
```

So it is a presence flag, not a carrier for an effort value — consistent with
effort being expressed in the model id. Unexplored: whether setting it changes
behaviour. It is not sent.

```
McpToolDefinition|1 name 9|4 provider_identifier 9|5 tool_name 9|2 description 9
  |3 input_schema #0|6 input_schema_json 9?|7 output_schema_json 9?|8 annotations_json 9?
```

Three fields beyond what we originally sent: `6 input_schema_json` (the same
schema as JSON **text**), `7 output_schema_json`, `8 annotations_json`. Field 6 is
now sent as well as field 3, because it is undocumented which one the server
reads and a schema that is delivered but not understood is invisible.

---

## Conversation state — and the token path, confirmed

```
ConversationState|1 root_prompt_messages_json 9*|8 turns #0*|3 todos #1*
  |4 pending_tool_calls 9*|5 token_details #2|6 summary #3?|7 plan #4?
  |9 summary_archive #5?|10 file_states 9,#6|11 summary_archives #5*|12 plans 9,#7
  |13 communicate_update_history #8*|14 communicate_update_final_summary 9?
  |15 communicate_update_completed_subtitle 9?
  |16 communicate_update_states_by_parent_tool_call_id 9,#9

ConversationTokenDetails|1 used_tokens 13|2 max_tokens 13|3 breakdown #0?
  |4 prompt_context_usage_tree #1?|5 prompt_context_usage_snapshot_blob_id 12?
```

**`token_details = 5`, `used_tokens = 1`** — the path this plugin now reads, and
the path the reference implementation documented. Two independent confirmations
plus a live capture (10,985 tokens on a second turn). The decoder previously
looked for `{1|2} → .8 → .1` and always returned `undefined`, so usage reported
zero forever.

`ConversationStateStructure` is the fuller sibling (`1 root_prompt_messages_json
12*`, `8 turns 12*`, and 37 more fields), which is what a checkpoint actually
carries. Field 8 `turns` is repeated and populated by the native client; this
plugin passes `turns: []`, following the reference's warning that current servers
treat hand-encoded field-8 turns as blob ids.

---

## The history family — the largest thing we do not use

```
ConversationHistory|1 messages #0*|2 replace_user_info 8?
ConversationHistoryMessage|1 user #0|2 assistant #1|3 tool #2
ConversationHistoryUserMessage|1 content #0*
ConversationHistoryUserContent|1 text #0|2 image #1
ConversationHistoryAssistantMessage|1 content #0*
ConversationHistoryAssistantContent|1 text #0|2 reasoning #1|3 redacted_reasoning #2|4 tool_call #3
ConversationHistoryToolMessage|1 tool_call_id 9|2 tool_name 9|3 content #0*|4 is_error 8?
  |5 hook_additional_contexts #1*
ConversationHistoryToolResultContent|1 text #0|2 image #1
ConversationHistoryToolCall|1 tool_call_id 9|2 tool_name 9|3 args_json 9
ConversationHistoryReasoningContent|1 text 9|2 signature 9?
ConversationHistoryTextContent|1 text 9
ConversationHistoryImageContent|1 data 9|2 mime_type 9?
```

**This plugin replays history as a labelled text transcript.** The protocol has
typed messages for every part of it — user turns, assistant turns, **tool calls
with their arguments**, **tool results**, and **reasoning** — and `ConversationStep`
plus `ConversationTurnStructure` exist to build turns from them.

That is the largest known gap. It matters for fidelity (a structured tool call is
not the same to a model as the sentence `[TOOL RESULT] …`), and it is a plausible
route to image delivery, because `ConversationHistoryUserContent` is where a user
message's image belongs — and `ConversationHistoryToolResultContent` shows a tool
result can carry one too.

The encoders for agent turns and turn structures exist in `lib/cursor-client.mjs`
and were dead code until `noUnusedLocals` flagged them; they are now exported as
the starting point for this work.

---

## Actions and execs

```
ConversationAction|1 user_message_action #0|2 resume_action #1|3 cancel_action #2
  |4 summarize_action #3|5 shell_command_action #4|6 start_plan_action #5
  |7 execute_plan_action #6|8 async_ask_question_completion_action #7
  |10 cancel_subagent_action #8|12 background_task_completion_action #9
  |13 background_shell_action #10|14 background_subagent_action #11
  |16 subscription_notification_action #12|18 goal_continuation_action #13
  |19 inject_context_action #14|11 triggering_auth_id 9?|15 triggering_user_info #15?
  |17 request_context_parts #16?

UserMessageAction|1 user_message #0|2 request_context #1
  |3 send_to_interaction_listener 8?|4 prepend_user_messages #0*
  |6 interrupted_pending_tool_call_resolutions #2?|7 conversation_history #3?
```

`UserMessageAction.conversation_history = 7` is where this plugin attaches images —
confirmed correct, and it is a `ConversationHistory` (`#3`), so the structured
history above is what it accepts.

`19 inject_context_action` and `17 request_context_parts` are the native
mechanisms for injecting context mid-run; `2 resume_action` is a dedicated resume
action carrying its own `request_context`.

```
RequestContextResult|1 success #0|2 error #1|3 rejected #2
RequestContextSuccess|1 request_context #0|2 served_from_disk_cache 8?
```

**`RequestContextResult` has a dedicated `rejected` variant (field 3).** This
plugin refuses with a generic `McpResult.error` on the exec's own field. The
generic refusal is proven to resume the run, so it works — but `rejected` is the
typed shape, and per-exec rejections (`ReadResult.rejected`, `ShellResult.rejected`)
sit alongside it.

```
RequestContext|2 rules #0*|4 env #1|6 repository_info #2*|7 tools #3*|...
```

53 fields, of which we populate one. `tools = 7` is confirmed.

### The complete exec enum (audited against cursor-agent 2026.10.01)

Mined from `~/.local/share/cursor-agent/versions/2026.10.01-e373342/index.js`,
not from observation alone. Field 36 was long misread here as "provider
routing" — it is `mcp_state_exec_args`, an MCP-server-state poll whose
`server_identifiers` named our provider, which is exactly why the payload
looked like routing.

```
ExecServerMessage (oneof)      reply slot on ExecClientMessage
  2  shell_args                2  shell_result        (ShellResult: rejected=4)
  3  write_args                3  write_result        (rejected=6)
  4  delete_args               4  delete_result       (rejected=6)
  5  grep_args                 5  grep_result         (error=2)
  7  read_args                 7  read_result         (rejected=3 {path,reason})
  8  ls_args                   8  ls_result           (rejected=3)
  9  diagnostics_args          9  diagnostics_result
 10  request_context_args     10  request_context_result
 11  mcp_args                 11  mcp_result          (success|error|rejected|...)
 14  shell_stream_args        14  shell_stream        (event stream; rejected=5)
 16  background_shell_spawn   16  ..._result          (rejected=3)
 17  list_mcp_resources       17  ..._result
 18  read_mcp_resource        18  ..._result          (not_found=4)
 19  span_context (scalar on the message, not a oneof arm)
 20  fetch_args               20  fetch_result        (error=2, rejected=3)
 21  record_screen_args       21  ...
 22  computer_use_args        22  ...
 23  write_shell_stdin_args   23  ..._result          (error=2)
 27  execute_hook_args        27  execute_hook_result
 28  subagent_args            28  subagent_result     → translated to Agent
 29  redacted_read_args       29  redacted_read_result (shares ReadArgs)
 30  force_background_shell   30  ..._result {status, shell_result?}
 31  force_background_subagent 31 ..._result {status}
 36  mcp_state_exec_args      36  mcp_state_exec_result (success|error|rejected)
 37  subagent_await_args      37  ..._result
 38  smart_mode_classifier    38  ..._result
 40  canvas_diagnostics_args  40  ..._result
 41  shell_allowlist_precheck 41  ..._result {allowlisted=1: bool}  ← flat bool
 42  mcp_allowlist_precheck   42  ..._result {allowlisted=1: bool}
 43  web_fetch_allowlist_precheck 43 ..._result {allowlisted=1: bool}
 44  git_diff_request         44  git_diff_response   → translated to Bash
 45  pi_read_args             45  pi_*_result         → Read
 46  pi_bash_args             46                      → Bash
 47  pi_edit_args             47                      → Edit (single edit)
 48  pi_write_args            48                      → Write
 49  pi_grep_args             49                      → Grep
 50  pi_find_args             50                      → Glob
 51  pi_ls_args               51                      → Glob
 52  mini_swe_agent_bash_args 52  (empty args; shares ShellResult)
 53  conversation_search_args 53  ..._result
 54  agent_store_conflict_args 54 ..._result
 55  accept_hook_additional_contexts (scalar, not a oneof arm)
 56  adopt_args               56  adopt_result
 57 machine_id (top-level scalar)
```

Unassigned in 1–56: 1, 6, 12, 13, 15, 24–26, 32–35, 39.

**There is no native old/new edit exec in the main family.** The only
string-replacement edit is `pi_edit` (field 47):
`PiEditExecArgs|1 path|2 edits*` with `PiEditReplacement|1 old_text|2 new_text`.
Semantic search exists only as MCP tool schemas, not as an exec.

Arg schemas that the translator consumes:

```
ReadArgs      |1 path 9|2 tool_call_id 9|4 offset 5?|5 limit 13?|6 encoding_hint 9?
GrepArgs      |1 pattern|2 path|3 glob|4 output_mode 9 (string: content|
               files_with_matches|count)|8 case_insensitive 8|10 head_limit 5|
               11 multiline 8|16 offset 5|14 tool_call_id|15 sandbox_policy
WriteArgs     |1 path 9|2 file_text 9|3 tool_call_id|4 return_file_content_after_write 8
FetchArgs     |1 url 9|2 tool_call_id 9
LsArgs        |1 path 9|2 ignore 9*|3 tool_call_id|5 timeout_ms 13?
ShellArgs     |1 command|2 working_directory|3 timeout 5|4 tool_call_id|… (24 fields)
SubagentArgs  |1 tool_call_id|2 subagent_type|3 model_id|4 prompt|5 readonly|
               6 resume_agent_id|7 run_in_background 8?|… (21 fields)
PiReadArgs    |1 path|2 offset 5?|3 limit 5?          PiBashArgs |1 command|2 timeout 1?
PiWriteArgs   |1 path|2 content                      PiGrepArgs |1 pattern|2 path?|3 glob?|
                                                        4 ignore_case 8?|5 literal 8?|6 context 5?|7 limit 5?
PiFindArgs    |1 pattern|2 path?|3 limit 5?          PiLsArgs   |1 path?|2 limit 5?
GetDiffRequest|1 cwd 9|2 ref 9|3 base_ref 9|4 merge_base 8|5 target_paths 9*|
               6 unified_context_lines 5?|8 output_format #0?|… (16 fields)
```

The live translation contract — which exec cases this build translates, into
which host tools, with which argument renames — is served by the running shim
at `/internal/translation`, so a dig reads what the code does, not what this
page said at some point.

---

## Image support: settled by Cursor's own answer

`AvailableModel` declares capabilities per model:

```
AvailableModel|1 name 9|5 supports_agent 8?|9 supports_thinking 8?|10 supports_images 8?
  |15 context_token_limit 5?|17 client_display_name 9?|18 server_model_name 9?|...
```

Queried live, the account returned **241 models and not one of them sets
`supports_images`**. Neither `supports_thinking` nor `context_token_limit` is set
either.

That closes the image question. It was never a transport bug: the shim's encoding
matches Cursor's own schema field for field, and the API states the capability is
unavailable. The empirical result — five models, two kinds of image, none seeing
it — now has a cause rather than a hypothesis.

It also means the honest `supportsImage: false` was correct, and it is now
**data-driven** rather than a blanket constant: the flag is read per model, so a
model that does declare image support would get it automatically.

## What this changed

| Finding | Action |
|---|---|
| `mcp_tools` on the run request | now sent, alongside the proven exec reply |
| `client_supports_inline_images` | now sent when an image is attached |
| `AvailableModel` capabilities | now decoded: `supports_images`, `supports_thinking`, `context_token_limit`, `client_display_name`. All read `false`/absent live, so image support is genuinely unavailable on this endpoint |
| `input_schema_json` (field 6) | now sent alongside the Value encoding |
| `token_details` path | confirmed; decoder fixed to read it |
| Structured history family | **Implemented** — encoders for every message, `buildStructuredHistory`, verified at the byte level. The server stalls on it (see below), so it is opt-in and off |
| `custom_system_prompt` | documented, not adopted (the blob path is proven) |
| `thinking_details` | exists, has no fields, not sent |

---

## Structured history: implemented, and refused by the server

The encoders are in `lib/cursor-client.mjs` and the mapping in
`buildConversation`/`buildStructuredHistory`. `CURSOR_STRUCTURED_HISTORY=1`
enables it. It is off because it was measured:

| Sent | Result |
|---|---|
| Text transcript in the action | reply in 4.5 s |
| Structured history with a tool call | no response in 120 s |
| Structured history, plain text only | no response in 90 s |

Plain text in that field stalls just as hard, so it is not an encoding mistake —
populating `UserMessageAction.conversation_history` with structured messages is
what the server will not take. Untested next step: whether it needs
`replace_user_info` set, or the history declared in `conversation_state` instead.

## Reproducing this

```sh
CLI=~/Library/Application\ Support/Cursor/User/globalStorage/anysphere.cursor-agent-worker/agent-cli
BUNDLE=$(find "$CLI" -name index.js | sort | tail -1)
grep -o 'static \$(){return\["[^"]*"\]}' "$BUNDLE" | head
```

To find a specific message:

```sh
grep -o 'AgentRunRequest|[^"]*' "$BUNDLE"
grep -o 'ConversationHistoryImageContent|[^"]*' "$BUNDLE"
```

Two cautions. The bundle is minified and versioned — the path contains a version
directory that moves with every release, so pull the newest. And Cursor's client
is one implementation of an undocumented protocol: it shows what the server
*accepts*, not what it *requires*.
