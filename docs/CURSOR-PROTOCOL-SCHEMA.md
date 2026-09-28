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
| Structured history family | documented, encoders exported, **not yet used** |
| `custom_system_prompt` | documented, not adopted (the blob path is proven) |
| `thinking_details` | exists, has no fields, not sent |

---

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
