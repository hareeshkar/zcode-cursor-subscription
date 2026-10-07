/**
 * Cursor Agent service client (`agent.v1`).
 *
 * Handles the wire half: protobuf message construction, Connect framing over
 * bidirectional HTTP/2, and decoding of the server frames we understand.
 *
 * Ported from `dsh-cursor-subscription` (MIT, orrinzeng) — see NOTICE.md.
 *
 * @module cursor-subscription/cursor-client
 */

import http2 from "node:http2";

import {
	AGENT_HEADERS,
	CURSOR_BASE_URL,
	CURSOR_MODELS_PATH,
	CURSOR_RUN_PATH,
	HEARTBEAT_INTERVAL_MS,
	STREAM_IDLE_TIMEOUT_MS,
	STREAM_PROGRESS_TIMEOUT_MS,
} from "./config.mjs";
import {
	decodeValue,
	CONNECT_END_STREAM_FLAG,
	ConnectFrameReader,
	TIMED_OUT,
	Reader,
	Writer,
	concatBytes,
	encodeValue,
	frameEncode,
	readFields,
} from "./proto.mjs";

/** Raised for any Cursor transport or protocol failure. */
export class CursorError extends Error {
	constructor(message, code = "CURSOR_ERROR", options) {
		super(message, options);
		this.name = "CursorError";
		this.code = code;
	}
}

const encoder = new TextEncoder();

function bytesOf(value) {
	return value instanceof Uint8Array ? value : new Uint8Array(value);
}

// ---------------------------------------------------------------------------
// Request encoders
// ---------------------------------------------------------------------------

/** UserMessage { text = 1, message_id = 2 } */
export function encodeUserMessage({ text, messageId }) {
	const writer = new Writer();
	if (typeof text === "string" && text.length > 0) writer.string(1, text);
	if (typeof messageId === "string" && messageId.length > 0) writer.string(2, messageId);
	return writer.finish();
}

function encodeAssistantMessage(text) {
	return new Writer().string(1, text).finish();
}

/** ConversationStep { assistant_message = 1 } */
export function encodeAssistantStep(text) {
	return new Writer().message(1, encodeAssistantMessage(text)).finish();
}

/** ModelDetails { model_id = 1, display_model_id = 3, display_name = 4 } */
export function encodeModelDetails(modelId) {
	const writer = new Writer();
	writer.string(1, modelId);
	writer.string(3, modelId);
	writer.string(4, modelId);
	return writer.finish();
}


/**
 * AgentConversationTurnStructure — the shape ConversationState.turns references.
 *
 *   AgentConversationTurnStructure|1 user_message 12|2 steps 12*|3 request_id 9?
 *     |4 encrypted_model 9?|5 dynamic_tool_count 13?|6 send_message_step_indices 13*
 *     |7 routed_model_display_name 9?|8 subagent_dispatch_steps #0*
 *     |9 dynamic_tool_names 9*|10 user_message_id 9?
 *
 * The `12`s matter: user_message and steps are bytes, and the reference
 * implementation's warning — "current Cursor servers treat them as blob ids" —
 * plus 32-byte ids observed inside real checkpoints say a turn is published to
 * the blob store and referenced by id, exactly as the root prompt is.
 */
export function encodeAgentTurn({ userMessage, steps = [], requestId, userMessageId } = {}) {
	const writer = new Writer();
	if (userMessage) writer.bytes(1, userMessage);
	for (const step of steps) writer.bytes(2, step);
	if (requestId) writer.string(3, requestId);
	if (userMessageId) writer.string(10, userMessageId);
	return writer.finish();
}

/** ConversationTurnStructure { agent_conversation_turn = 1 }. */
export function encodeConversationTurn(agentTurnBytes) {
	return new Writer().message(1, agentTurnBytes).finish();
}
// ---------------------------------------------------------------------------
// Native conversation history
//
// Cursor's own schema, from its client bundle:
//
//   ConversationHistory         |1 messages #0*|2 replace_user_info 8?
//   ConversationHistoryMessage  |1 user #0|2 assistant #1|3 tool #2
//   ConversationHistoryUserMessage      |1 content #0*
//   ConversationHistoryAssistantMessage |1 content #0*
//   ConversationHistoryToolMessage      |1 tool_call_id 9|2 tool_name 9
//                                       |3 content #0*|4 is_error 8?
//   ConversationHistoryUserContent      |1 text #0|2 image #1
//   ConversationHistoryAssistantContent |1 text #0|2 reasoning #1
//                                       |3 redacted_reasoning #2|4 tool_call #3
//   ConversationHistoryToolResultContent|1 text #0|2 image #1
//   ConversationHistoryTextContent      |1 text 9
//   ConversationHistoryImageContent     |1 data 9|2 mime_type 9?
//   ConversationHistoryReasoningContent |1 text 9|2 signature 9?
//   ConversationHistoryToolCall         |1 tool_call_id 9|2 tool_name 9|3 args_json 9
//
// The `#n` markers are nested *type* indices, not field numbers. Each content
// kind is a oneof arm carrying its own field number, and the arms are repeated,
// so one assistant message can hold text, reasoning and several tool calls.
// ---------------------------------------------------------------------------

/** One content arm of a user message: `{ text }` or `{ image: {data, mimeType} }`. */
function encodeUserContent(part) {
	if (part?.image) {
		const image = new Writer().string(1, part.image.data);
		if (part.image.mimeType) image.string(2, part.image.mimeType);
		return new Writer().message(2, image.finish()).finish();
	}
	return new Writer().message(1, new Writer().string(1, String(part?.text ?? "")).finish()).finish();
}

/** One content arm of a tool result: text or image. */
function encodeToolResultContent(part) {
	if (part?.image) {
		const image = new Writer().string(1, part.image.data);
		if (part.image.mimeType) image.string(2, part.image.mimeType);
		return new Writer().message(2, image.finish()).finish();
	}
	return new Writer().message(1, new Writer().string(1, String(part?.text ?? "")).finish()).finish();
}

/** One content arm of an assistant message: text, reasoning or a tool call. */
function encodeAssistantContent(part) {
	if (part?.toolCall) {
		const call = new Writer().string(1, part.toolCall.toolCallId ?? "");
		if (part.toolCall.toolName) call.string(2, part.toolCall.toolName);
		call.string(3, part.toolCall.argsJson ?? "{}");
		return new Writer().message(4, call.finish()).finish();
	}
	if (part?.reasoning) {
		return new Writer().message(2, new Writer().string(1, part.reasoning).finish()).finish();
	}
	return new Writer().message(1, new Writer().string(1, String(part?.text ?? "")).finish()).finish();
}

/** ConversationHistoryMessage carrying a user turn. */
export function encodeHistoryUser({ text = "", images = [] } = {}) {
	const content = new Writer();
	if (text.length > 0) content.message(1, encodeUserContent({ text }));
	for (const image of images) content.message(1, encodeUserContent({ image }));
	const user = new Writer().message(1, content.finish()).finish();
	return new Writer().message(1, user).finish();
}

/** ConversationHistoryMessage carrying an assistant turn: text, reasoning, tool calls. */
export function encodeHistoryAssistant({ text = "", reasoning = "", toolCalls = [] } = {}) {
	const content = new Writer();
	if (reasoning.length > 0) content.message(1, encodeAssistantContent({ reasoning }));
	if (text.length > 0) content.message(1, encodeAssistantContent({ text }));
	for (const toolCall of toolCalls) content.message(1, encodeAssistantContent({ toolCall }));
	const assistant = new Writer().message(1, content.finish()).finish();
	return new Writer().message(2, assistant).finish();
}

/** ConversationHistoryMessage carrying a tool result. */
export function encodeHistoryTool({ toolCallId = "", toolName = "", text = "", isError = false, images = [] } = {}) {
	const message = new Writer().string(1, toolCallId);
	if (toolName) message.string(2, toolName);
	const content = new Writer();
	content.message(1, encodeToolResultContent({ text }));
	for (const image of images) content.message(1, encodeToolResultContent({ image }));
	message.message(3, content.finish());
	if (isError) message.varint(4, 1);
	// ConversationHistoryMessage.tool = 3, and field 3 holds the tool message
	// directly. It was nested one level too deep — inside field 1 — so the wire
	// carried a message whose tool slot was empty. Caught by walking the encoded
	// bytes in a test rather than by reading the code.
	return new Writer().message(3, message.finish()).finish();
}

/** ConversationHistory { messages = 1 } wrapping prepared HistoryMessages. */
export function encodeConversationHistory(messages) {
	const writer = new Writer();
	for (const message of messages) writer.message(1, message);
	return writer.finish();
}

/** ConversationAction carrying pre-encoded history messages. */
export function encodeUserMessageActionWithHistory(userBytes, historyMessages = []) {
	const inner = new Writer().message(1, userBytes);
	if (historyMessages.length > 0) {
		inner.message(7, encodeConversationHistory(historyMessages));
	}
	return new Writer().message(1, inner.finish()).finish();
}

/** ConversationAction { user_message_action = 1 } */
export function encodeUserMessageAction(userBytes, images = []) {
	const inner = new Writer().message(1, userBytes);
	if (images.length > 0) {
		// The image-only path predates structured history and is kept for it.
		const history = new Writer();
		for (const image of images) {
			history.message(1, encodeHistoryUser({ images: [image] }));
		}
		inner.message(7, history.finish());
	}
	return new Writer().message(1, inner.finish()).finish();
}

/**
 * ConversationStateStructure { root_prompt_messages_json = 1, turns = 8 }.
 *
 * There is no cache-control field anywhere in this message — Cursor's protocol
 * exposes no way to mark a cache breakpoint. See docs/RESEARCH-FINDINGS.md §6.7.
 */
export function encodeConversationState({ rootPromptBlobIds = [], turns = [] }) {
	const writer = new Writer();
	for (const id of rootPromptBlobIds) writer.bytes(1, id);
	for (const turn of turns) writer.bytes(8, turn);
	return writer.finish();
}

/**
 * AgentRunRequest — schema taken from Cursor's own client bundle:
 *
 *   AgentRunRequest|1 conversation_state|2 action|3 model_details|9 requested_model
 *     |4 mcp_tools #4|5 conversation_id|6 mcp_file_system_options|7 skill_options
 *     |8 custom_system_prompt|...|19 client_supports_inline_images 8?|...
 *
 * Three of those fields matter and were previously unsent:
 *
 *   4  mcp_tools                      tools declared up-front, natively
 *   19 client_supports_inline_images  a capability flag; without it the server has
 *                                     no reason to surface an image to the model,
 *                                     which is the best explanation found for why
 *                                     correctly-encoded images were never seen
 *
 * The tools are still also served on the exec reply, because that path is proven
 * and the server may take either. Declaring them up-front costs nothing and
 * removes a round-trip.
 */
export function encodeRunRequest({
	conversationState,
	action,
	modelDetails,
	conversationId,
	mcpTools,
	clientSupportsInlineImages = false,
}) {
	const writer = new Writer();
	writer.message(1, conversationState);
	writer.message(2, action);
	writer.message(3, modelDetails);
	if (mcpTools && mcpTools.length > 0) writer.message(4, encodeMcpTools(mcpTools));
	// conversation_id is the server-native resumption anchor. Its presence is
	// the entire difference between an O(new) and an O(history) turn.
	if (conversationId) writer.string(5, conversationId);
	if (clientSupportsInlineImages) writer.varint(19, 1);
	return writer.finish();
}

/** McpTools { mcp_tools = 1 (repeated) } */
export function encodeMcpTools(tools) {
	const writer = new Writer();
	for (const tool of tools) writer.message(1, tool);
	return writer.finish();
}

/** AgentClientMessage { run_request = 1 } */
export function encodeRunMessage(runRequestBytes) {
	return new Writer().message(1, runRequestBytes).finish();
}

/** ExecClientMessage { id=1, exec_id=2, result=3 } — one exec reply slot. */
export function encodeExecClientMessage(id, execId, messageField, messageBytes) {
	const writer = new Writer();
	writer.varint(1, id);
	// exec_id is field 15, matching the decoder that reads ExecServerMessage.
	if (execId) writer.string(15, execId);
	writer.message(messageField, messageBytes);
	return writer.finish();
}

/** ExecClientMessageEnvelope { exec_client_message = 1 } */
export function encodeExecClientMessageEnvelope(execBytes) {
	// AgentClientMessage.exec_client_message = 2. Field 1 is run_request; writing
	// here makes the server read the tool schemas as a malformed run request.
	return new Writer().message(2, execBytes).finish();
}

/**
 * McpToolDefinition — schema confirmed against Cursor's own client bundle:
 *
 *   McpToolDefinition|1 name 9|4 provider_identifier 9|5 tool_name 9|2 description 9
 *                    |3 input_schema #0|6 input_schema_json 9?|7 output_schema_json 9?
 *                    |8 annotations_json 9?
 *
 * Field 3 is a `google.protobuf.Value` and field 6 is the same schema as a JSON
 * *string*. This sends both: Cursor's own client is the authority on which it
 * reads, it is not documented, and a tool whose schema is delivered but not
 * understood is invisible — the exact failure mode that made tool calling look
 * like it worked while doing nothing.
 */
export function encodeMcpToolDefinition({ name, description, inputSchema, providerIdentifier, toolName }) {
	const schema = inputSchema ?? { type: "object", properties: {} };
	const writer = new Writer();
	writer.string(1, name);
	writer.string(2, description ?? "");
	writer.bytes(3, bytesOf(encodeValue(schema)));
	writer.string(4, providerIdentifier ?? "zcode-cursor-subscription");
	writer.string(5, toolName ?? name);
	writer.string(6, JSON.stringify(schema));
	return writer.finish();
}


/**
 * Typed rejections for every Cursor built-in exec.
 *
 * Cursor's own bundle declares a distinct result message per exec, each with a
 * dedicated rejection arm:
 *
 *   ShellResult   { rejected=4: ShellRejected }      ShellStream  { rejected=5 }
 *   ReadResult    { rejected=3: {path, reason} }     LsResult     { rejected=3 }
 *   GrepResult    { error=2: {error} }               WriteResult  { rejected=6 }
 *   DeleteResult  { rejected=6 }                     FetchResult  { error=2: {url, error} }
 *   BackgroundShellSpawnResult { rejected=3 }        WriteShellStdinResult { error=2 }
 *   DiagnosticsResult { success=1 }                  McpResult    { error=2 }
 *
 * The reply travels on the exec's own field with the shape that field expects.
 * A generic error shape on a streaming shell exec left the server waiting — the
 * run stalled with no error anywhere — which is why the per-exec shapes matter
 * even though a wrong-but-present reply works for some execs.
 */
export function rejectionFor(exec, reason) {
	// The exec's own argument (command, path, pattern, url) is echoed back so the
	// server can pair the rejection with what it asked for. It lives in
	// `exec.args` — the positional aliases used here previously did not exist on
	// the decoded exec, so every rejection echoed an empty string.
	const own = exec.args?.primary;
	switch (exec.case) {
		case "shellArgs":
			return { field: 2, payload: shellRejectedResult(4, own, reason) };
		case "shellStreamArgs":
			return { field: 14, payload: shellRejectedResult(5, own, reason) };
		case "backgroundShellSpawnArgs":
			return { field: 16, payload: shellRejectedResult(3, own, reason) };
		case "readArgs":
			return { field: 7, payload: pathRejected(3, own, reason) };
		case "lsArgs":
			return { field: 8, payload: pathRejected(3, own, reason) };
		case "grepArgs":
			return { field: 5, payload: errorResult(2, own || reason) };
		case "writeArgs":
			return { field: 3, payload: pathRejected(6, own, reason) };
		case "deleteArgs":
			return { field: 4, payload: pathRejected(6, own, reason) };
		case "fetchArgs":
			return { field: 20, payload: fetchError(own, reason) };
		case "writeShellStdinArgs":
			return { field: 23, payload: errorResult(2, reason) };
		case "shellAllowlistPrecheckArgs":
		case "mcpAllowlistPrecheckArgs":
		case "webFetchAllowlistPrecheckArgs": {
			// The precheck result is a flat bool — `allowlisted = 1` — not an
			// error oneof, so the generic error shape cannot answer it. False is
			// the honest answer: the host's permission system is the allowlist,
			// and nothing is pre-approved here. The real exec that follows is
			// translated or refused on its own merits.
			return { field: exec.field, payload: new Writer().varint(1, 0).finish() };
		}
		case "diagnosticsArgs":
			return { field: 9, payload: new Writer().message(1, new Uint8Array(0)).finish() };
		case "recordScreenArgs":
		case "computerUseArgs":
		case "listMcpResourcesExecArgs":
		case "readMcpResourceExecArgs":
			return { field: exec.field, payload: encodeMcpError(reason) };
		default:
			// An exec variant newer than this build. The generic error shape on the
			// exec's own field is proven to resume the run (the field-36 case).
			if (typeof exec.field !== "number") return undefined;
			return { field: exec.field, payload: encodeMcpError(reason) };
	}
}

/** ShellRejected { command=1, working_directory=2, reason=3, is_readonly=4 }. */
function shellRejectedResult(rejectedField, command, reason) {
	const rejected = new Writer()
		.string(1, command ?? "")
		.string(2, "")
		.string(3, reason)
		.varint(4, 1)
		.finish();
	return new Writer().message(rejectedField, rejected).finish();
}

/** { path=1, reason=2 } inside the given rejected arm. */
function pathRejected(rejectedField, path, reason) {
	const rejected = new Writer().string(1, path ?? "").string(2, reason).finish();
	return new Writer().message(rejectedField, rejected).finish();
}

/** { error=1 } inside the given error arm. */
function errorResult(errorField, error) {
	return new Writer().message(errorField, new Writer().string(1, error).finish()).finish();
}

/** FetchResult { error=2 { url=1, error=2 } }. */
function fetchError(url, reason) {
	const inner = new Writer().string(1, url ?? "").string(2, reason).finish();
	return new Writer().message(2, inner).finish();
}

/** McpResult { success=1 | error=2 { message=1 } } — the generic "not available" reply. */
export function encodeMcpError(error) {
	return new Writer().message(2, new Writer().string(1, error).finish()).finish();
}

/** RequestContextResult { RequestContextSuccess = 1 { tools = 7 } } */
export function encodeRequestContextResult(tools) {
	const context = new Writer();
	for (const tool of tools) context.message(7, tool);
	const success = new Writer().message(1, context.finish()).finish();
	return new Writer().message(1, success).finish();
}

// ---------------------------------------------------------------------------
// KV blob channel
//
// Cursor's `ConversationState` references content by blob id rather than
// inlining it. A root prompt (our system text) is published as a blob and
// served back on request. Without this handshake the run stalls.
// ---------------------------------------------------------------------------

/** GetBlobResult { data = 1 } wrapped as KvClientMessage { id = 1, get_blob_result = 2 } */
export function encodeGetBlobResult(id, blobData) {
	const inner = blobData === undefined ? new Uint8Array(0) : blobData;
	const result = new Writer().bytes(1, inner).finish();
	return new Writer().varint(1, id).message(2, result).finish();
}

/** AgentClientMessage { kv_client_message = 3 } */
export function encodeKvClientMessage(kvBytes) {
	return new Writer().message(3, kvBytes).finish();
}

/** KvClientMessage { id = 1, set_blob_result = 3 } — acknowledge a server blob write. */
export function encodeSetBlobResult(id) {
	return new Writer().varint(1, id).message(3, new Uint8Array(0)).finish();
}

function decodeBlobId(bytes) {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) return reader.bytes();
		reader.skip(wireType);
	}
	return undefined;
}

/** KvServerMessage { id=1, get_blob_args=2 | set_blob_args=3 } */
export function decodeKvServerMessage(bytes) {
	const reader = new Reader(bytes);
	let id = 0;
	let blobId;
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 0) {
			id = reader.varint();
		} else if (field === 2 && wireType === 2) {
			blobId = decodeBlobId(reader.bytes());
		} else if (field === 3 && wireType === 2) {
			const inner = new Reader(reader.bytes());
			let setBlobId;
			let blobData;
			while (!inner.done) {
				const innerTag = inner.tag();
				if (innerTag.field === 1 && innerTag.wireType === 2) setBlobId = inner.bytes();
				else if (innerTag.field === 2 && innerTag.wireType === 2) blobData = inner.bytes();
				else inner.skip(innerTag.wireType);
			}
			return { id, case: "setBlobArgs", blobId: setBlobId, blobData };
		} else {
			reader.skip(wireType);
		}
	}
	return blobId === undefined
		? { id, case: "unknown" }
		: { id, case: "getBlobArgs", blobId };
}

// ---------------------------------------------------------------------------
// Response decoders
// ---------------------------------------------------------------------------

function decodeTextDelta(bytes) {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) return reader.string();
		reader.skip(wireType);
	}
	return "";
}

function decodeTokenDelta(bytes) {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 0) return reader.varint();
		reader.skip(wireType);
	}
	return 0;
}

/**
 * The authoritative input-token count for the conversation Cursor is holding.
 *
 * Path: checkpoint → `token_details` (field 5) → `used_tokens` (field 1).
 *
 * This previously looked for `{1|2} → .8 → .1`, which never matched anything, so
 * it always returned `undefined` and every response reported `prompt_tokens: 0`.
 * The host derives its compaction threshold from that number, so reporting zero
 * forever meant compaction could not fire on real usage.
 *
 * Resolved against a live capture rather than by argument. A checkpoint taken
 * after a real turn carried a 286-byte field 5 decoding as:
 *
 *   field 1 = 10985     used tokens — a plausible count for that context
 *   field 2 = 200000    the context window
 *   field 3 = a per-section breakdown, with `system_prompt` visible in it
 *
 * field 5 is absent-to-empty on the very first minimal checkpoint and populated
 * from the second turn onward, which is consistent with there being nothing to
 * count yet.
 */
export function decodeCheckpointUsedTokens(checkpoint) {
	try {
		const details = readFields(checkpoint).find((f) => f.field === 5)?.bytes;
		if (!details) return undefined;
		const reader = new Reader(details);
		while (!reader.done) {
			const { field, wireType } = reader.tag();
			if (wireType === 0) {
				const value = reader.varint();
				// Field 2 of the same message is the context window, which is large
				// and could be mistaken for a count if the fields were not distinct.
				if (field === 1 && value > 0) return value;
			} else {
				reader.skip(wireType);
			}
		}
	} catch {
		// Accounting is best-effort; never fail a run over it.
	}
	return undefined;
}

/** InteractionUpdate { text_delta=1, thinking_delta=4, token_delta=8, turn_ended=14 } */
export function decodeInteractionUpdate(bytes) {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (wireType !== 2) {
			reader.skip(wireType);
			continue;
		}
		const payload = reader.bytes();
		if (field === 1) return { type: "textDelta", text: decodeTextDelta(payload) };
		if (field === 4) return { type: "thinkingDelta", text: decodeTextDelta(payload) };
		if (field === 5) return { type: "thinkingCompleted" };
		if (field === 8) return { type: "tokenDelta", tokens: decodeTokenDelta(payload) };
		if (field === 14) return { type: "turnEnded" };
		if (field === 2) return { type: "toolCallStarted" };
		if (field === 3) return { type: "toolCallCompleted" };
		if (field === 7) return { type: "partialToolCall" };
		if (field === 15) return { type: "toolCallDelta" };
		if (field === 13) return { type: "heartbeat" };
	}
	return { type: "unknown" };
}

const EXEC_SPAN_CONTEXT_FIELD = 19;

/**
 * ExecServerMessage — a request from Cursor's model for a tool to run.
 *
 * `case: "unknown"` deliberately preserves the message's own field number.
 * Cursor adds exec variants without notice, and silence on an unknown field
 * wedges the run: the server waits forever for a reply. Any coherent reply
 * resumes it, so the field number is what makes rejection possible.
 */

/** Field 1 of an args payload as a string — the primary identifier of most execs. */
function decodeSinglePathArg(bytes) {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) return reader.string();
		reader.skip(wireType);
	}
	return "";
}

export function decodeExecServerMessage(bytes) {
	const reader = new Reader(bytes);
	let id = 0;
	let execId = "";
	let unknownField;
	const seen = [];
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		seen.push(field);
		if (field === 1 && wireType === 0) {
			id = reader.varint();
		} else if (field === 15 && wireType === 2) {
			execId = reader.string();
		} else if (wireType === 2) {
			const payload = reader.bytes();
			// Every case carries its own field number. It is what the reply must
			// be addressed to, and dropping it for the *known* variants is how a
			// `readArgs` exec went entirely unanswered and hung the run: the
			// refusal path had no slot to reply into, so nothing was sent.
			// Decode the fields the translation layer needs, per Cursor's own arg
			// schemas (ShellArgs|1 tool_call_id, ReadArgs|1 path|4 offset|5 limit,
			// GrepArgs|1 pattern|2 path|3 glob, WriteArgs|1 path|2 file_text,
			// FetchArgs|1 url, BackgroundShellSpawnArgs|1 command, ...).
			//
			// `fields` keeps every argument by number — strings and varints alike.
			// The positional aliases only ever saw length-delimited fields 1-4, so
			// ReadArgs' offset and limit (varints at 4 and 5) were dropped before
			// the translation layer could pass them on.
			const args = { fields: {} };
			{
				const ar = new Reader(payload);
				while (!ar.done) {
					const t2 = ar.tag();
					if (t2.wireType === 2) {
						const text = new TextDecoder().decode(ar.bytes());
						args.fields[t2.field] = text;
						if (t2.field === 1) args.primary = text;
						else if (t2.field === 2) args.second = text;
						else if (t2.field === 3) args.third = text;
						else if (t2.field === 4) args.fourth = text;
					} else if (t2.wireType === 0) {
						args.fields[t2.field] = ar.varint();
					} else {
						ar.skip(t2.wireType);
					}
				}
			}
			const base = { id, execId, field, args };
			if (field === 10) return { ...base, case: "requestContextArgs" };
			if (field === 11) return { ...base, case: "mcpArgs", args: decodeMcpArgs(payload) };
			if (field === 2) return { ...base, case: "shellArgs" };
			if (field === 3) return { ...base, case: "writeArgs" };
			if (field === 4) return { ...base, case: "deleteArgs" };
			if (field === 5) return { ...base, case: "grepArgs" };
			if (field === 7) return { ...base, case: "readArgs" };
			if (field === 8) return { ...base, case: "lsArgs" };
			if (field === 9) return { ...base, case: "diagnosticsArgs" };
			if (field === 14) return { ...base, case: "shellStreamArgs" };
			if (field === 16) return { ...base, case: "backgroundShellSpawnArgs" };
			if (field === 17) return { ...base, case: "listMcpResourcesExecArgs" };
			if (field === 18) return { ...base, case: "readMcpResourceExecArgs" };
			if (field === 20) return { ...base, case: "fetchArgs" };
			if (field === 21) return { ...base, case: "recordScreenArgs" };
			if (field === 22) return { ...base, case: "computerUseArgs" };
			if (field === 23) return { ...base, case: "writeShellStdinArgs" };
			// The rest of the oneof, named so counters and refusals are legible
			// rather than "unknown #28". Schemas from cursor-agent's own bundle
			// (2026.10.01) — see docs/CURSOR-PROTOCOL-SCHEMA.md for the table.
			if (field === 27) return { ...base, case: "executeHookArgs" };
			if (field === 28) return { ...base, case: "subagentArgs" };
			if (field === 29) return { ...base, case: "redactedReadArgs" };
			if (field === 30) return { ...base, case: "forceBackgroundShellArgs" };
			if (field === 31) return { ...base, case: "forceBackgroundSubagentArgs" };
			if (field === 36) return { ...base, case: "mcpStateExecArgs" };
			if (field === 37) return { ...base, case: "subagentAwaitArgs" };
			if (field === 38) return { ...base, case: "smartModeClassifierArgs" };
			if (field === 40) return { ...base, case: "canvasDiagnosticsArgs" };
			if (field === 41) return { ...base, case: "shellAllowlistPrecheckArgs" };
			if (field === 42) return { ...base, case: "mcpAllowlistPrecheckArgs" };
			if (field === 43) return { ...base, case: "webFetchAllowlistPrecheckArgs" };
			if (field === 44) {
				// GetDiffRequest | 5 target_paths* is repeated, so the generic
				// reader (last-occurrence-wins) would keep one path; collect them.
				const paths = [];
				{
					const ar = new Reader(payload);
					while (!ar.done) {
						const t2 = ar.tag();
						if (t2.wireType !== 2) { ar.skip(t2.wireType); continue; }
						const v = ar.bytes();
						if (t2.field === 5) paths.push(new TextDecoder().decode(v));
					}
				}
				args.paths = paths;
				return { ...base, case: "gitDiffRequestArgs" };
			}
			if (field === 45) return { ...base, case: "piReadArgs" };
			if (field === 46) return { ...base, case: "piBashArgs" };
			if (field === 47) {
				// PiEditExecArgs | 1 path | 2 edits* (PiEditReplacement | 1 old_text |
				// 2 new_text). `edits` is repeated, so the generic positional reader
				// (which keeps the last occurrence as text) cannot see it — decode
				// the nested replacements here, where the Reader lives.
				const edits = [];
				{
					const ar = new Reader(payload);
					let path;
					while (!ar.done) {
						const t2 = ar.tag();
						if (t2.wireType !== 2) { ar.skip(t2.wireType); continue; }
						const v = ar.bytes();
						if (t2.field === 1) path = new TextDecoder().decode(v);
						else if (t2.field === 2) {
							const inner = new Reader(v);
							let oldText = "";
							let newText = "";
							while (!inner.done) {
								const t3 = inner.tag();
								if (t3.wireType !== 2) { inner.skip(t3.wireType); continue; }
								const raw = inner.bytes();
								const text = new TextDecoder().decode(raw);
								if (t3.field === 1) oldText = text;
								else if (t3.field === 2) newText = text;
							}
							edits.push({ oldText, newText });
						}
					}
					args.edits = edits;
					if (path !== undefined) args.fields[1] = path;
				}
				return { ...base, case: "piEditArgs" };
			}
			if (field === 48) return { ...base, case: "piWriteArgs" };
			if (field === 49) return { ...base, case: "piGrepArgs" };
			if (field === 50) return { ...base, case: "piFindArgs" };
			if (field === 51) return { ...base, case: "piLsArgs" };
			if (field === 52) return { ...base, case: "miniSweAgentBashArgs" };
			if (field === 53) return { ...base, case: "conversationSearchArgs" };
			if (field === 54) return { ...base, case: "agentStoreConflictArgs" };
			if (field === 56) return { ...base, case: "adoptArgs" };
			if (field !== EXEC_SPAN_CONTEXT_FIELD) unknownField ??= field;
		} else {
			reader.skip(wireType);
		}
	}
	return { id, execId, case: "unknown", field: unknownField, seen };
}

/** McpArgs — a call to one of the tool definitions we registered. */
/**
 * McpArgs — a call to one of the tool definitions we registered.
 *
 * Schema: `name=1`, `args=2` (a map<string, google.protobuf.Value> encoded as
 * repeated entries with key=1, value=2), `tool_call_id=3`,
 * `provider_identifier=4`, `tool_name=5`.
 *
 * The map entry encoding is why this must be read this way: field 2 is a
 * repeated message, not a string, and reading it as one truncates the frame.
 */
export function decodeMcpArgs(bytes) {
	const reader = new Reader(bytes);
	let name = "";
	let toolCallId = "";
	let providerIdentifier = "";
	let toolName = "";
	/** Raw google.protobuf.Value bytes, keyed by argument name. */
	const rawArgs = new Map();

	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (wireType === 0) {
			reader.varint();
			continue;
		}
		if (wireType !== 2) {
			reader.skip(wireType);
			continue;
		}
		const payload = reader.bytes();
		if (field === 1) {
			name = decodePlainString(payload);
		} else if (field === 3) {
			toolCallId = decodePlainString(payload);
		} else if (field === 4) {
			providerIdentifier = decodePlainString(payload);
		} else if (field === 5) {
			toolName = decodePlainString(payload);
		} else if (field === 2) {
			// map entry: key = 1 (string), value = 2 (serialized Value).
			const entry = new Reader(payload);
			let key = "";
			let value;
			while (!entry.done) {
				const tag = entry.tag();
				if (tag.field === 1 && tag.wireType === 2) key = entry.string();
				else if (tag.field === 2 && tag.wireType === 2) value = entry.bytes();
				else entry.skip(tag.wireType);
			}
			if (key.length > 0) rawArgs.set(key, value ? Uint8Array.from(value) : new Uint8Array(0));
		}
	}

	const args = {};
	for (const [key, value] of rawArgs) {
		try {
			args[key] = decodeValue(value);
		} catch {
			// A malformed argument must not abort the turn; the model sees the
			// call with whatever arguments did decode.
		}
	}

	// Cursor populates either name or tool_name; the reference prefers tool_name.
	const resolvedName = toolName || name;
	return { toolName: resolvedName, callId: toolCallId, args, name, providerIdentifier };
}

/** Read a length-delimited string field directly (no nested message). */
function decodePlainString(bytes) {
	try {
		return new TextDecoder().decode(bytes);
	} catch {
		return "";
	}
}

/** GetUsableModelsResponse { models = 1: repeated ModelDetails } */
export function decodeUsableModels(bytes) {
	const models = [];
	let reader;
	try {
		reader = new Reader(bytes);
	} catch {
		return models;
	}
	try {
		while (!reader.done) {
			const { field, wireType } = reader.tag();
			if (field === 1 && wireType === 2) {
				const model = decodeAvailableModel(reader.bytes());
				if (model) models.push(model);
			} else {
				reader.skip(wireType);
			}
		}
	} catch {
		// A partially decodable response still yields usable models.
	}
	return models;
}

/**
 * Decode one `AvailableModel`, using Cursor's own schema:
 *
 *   AvailableModel|1 name 9|5 supports_agent 8?|9 supports_thinking 8?
 *     |10 supports_images 8?|15 context_token_limit 5?|17 client_display_name 9?
 *     |18 server_model_name 9?|...
 *
 * Only the name was read before, which threw away three facts Cursor states
 * outright: whether a model takes images, how large its context actually is, and
 * what to call it. Guessing those produced a plugin that advertised every model
 * as text-only with the same invented 200k window.
 *
 * Returns `undefined` when there is no name, so a malformed entry is skipped
 * rather than becoming a nameless model.
 */
export function decodeAvailableModel(bytes) {
	const reader = new Reader(bytes);
	const model = { name: "", supportsImages: false, supportsThinking: false, contextTokenLimit: undefined, displayName: undefined };
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (wireType === 2) {
			const value = reader.string();
			if (field === 1) model.name = value;
			else if (field === 17) model.displayName = value;
		} else if (wireType === 0) {
			const value = reader.varint();
			if (field === 10) model.supportsImages = value === 1;
			else if (field === 9) model.supportsThinking = value === 1;
			else if (field === 15 && value > 0) model.contextTokenLimit = value;
		} else {
			reader.skip(wireType);
		}
	}
	return model.name ? model : undefined;
}

/**
 * Split one `AgentServerMessage` payload into its constituent messages.
 *
 * The message is a oneof, so the top-level field number identifies what arrived:
 * 1 interaction update, 2 exec request, 3 conversation checkpoint, 4 KV blob.
 * Field 3 is the resumption anchor — see docs/RESEARCH-FINDINGS.md 6.9.
 */
/**
 * Split a Connect frame into its messages.
 *
 * The arms are declared by Cursor's own client:
 *
 *   AgentServerMessage|1 interaction_update #0|2 exec_server_message #1
 *     |5 exec_server_control_message #2|3 conversation_checkpoint_update #3
 *     |4 kv_server_message #4|7 interaction_query #5|8 ttft_breakdown #6
 *
 * Only 1-4 were decoded, and the rest were dropped without a trace — no frame
 * object, no debug line, no counter. That matters beyond tidiness: a run that
 * stalls cannot be diagnosed if a third of the wire is invisible, and a stall was
 * indeed diagnosed here while this was true. Unrecognised arms are now returned as
 * `unknown` so they can be counted and seen.
 */
export function splitServerMessage(payload) {
	const out = [];
	let reader;
	try {
		reader = new Reader(payload);
	} catch {
		return out;
	}
	try {
		while (!reader.done) {
			const { field, wireType } = reader.tag();
			if (wireType !== 2) {
				reader.skip(wireType);
				continue;
			}
			const inner = reader.bytes();
			if (field === 1) out.push({ kind: "interaction", payload: inner });
			else if (field === 2) out.push({ kind: "exec", payload: inner });
			else if (field === 3) out.push({ kind: "checkpoint", payload: inner });
			else if (field === 4) out.push({ kind: "kv", payload: inner });
			else if (field === 5) out.push({ kind: "abort", payload: inner });
			else if (field === 7) out.push({ kind: "query", payload: inner });
			else if (field === 8) out.push({ kind: "ttft", payload: inner });
			else out.push({ kind: "unknown", field, payload: inner });
		}
	} catch {
		// Partial frames still yield whatever was decoded.
	}
	return out;
}

/** Describe a frame we do not decode, for diagnostics. Never throws. */
export function describeServerFrame(frame) {
	if ((frame.flags & CONNECT_END_STREAM_FLAG) !== 0) {
		return `endstream(${encoder.encode("").length})`;
	}
	try {
		return `fields#${readFields(frame.payload).map((f) => f.field).join(",")}`;
	} catch {
		return "unreadable";
	}
}


// ---------------------------------------------------------------------------
// The remaining AgentServerMessage arms
//
//   5 exec_server_control_message #2  → ExecServerControlMessage{abort}
//   7 interaction_query #5            → server-initiated query; InteractionResponse
//                                        exists, so an unanswered one may stall a run
//   8 ttft_breakdown #6               → timing telemetry; informational, no reply
// ---------------------------------------------------------------------------

/** TtftBreakdown — timing metrics the server reports after a run. Informational. */
export function decodeTtftBreakdown(bytes) {
	const reader = new Reader(bytes);
	const out = {};
	// TtftBreakdown|1 server_first_token_ms 1|2 pre_stream_setup_ms 1
	//   |3 wait_for_first_event_ms 1|4 provider_ttft_ms 1?|5 slow_pool_wait_ms 1
	// (the trailing `1` is Cursor's marker for a fixed64 double)
	const names = new Map([
		[1, "serverFirstTokenMs"],
		[2, "preStreamSetupMs"],
		[3, "waitForFirstEventMs"],
		[4, "providerTtftMs"],
		[5, "slowPoolWaitMs"],
	]);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (wireType === 1) {
			const value = reader.double();
			const name = names.get(field);
			if (name) out[name] = value;
		} else {
			reader.skip(wireType);
		}
	}
	return out;
}

/** ExecServerControlMessage { abort = 1 }. */
export function decodeExecServerControl(bytes) {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) return { aborted: true, payload: reader.bytes() };
		if (wireType === 2) reader.bytes();
		else reader.skip(wireType);
	}
	return { aborted: false };
}

/**
 * InteractionQuery — the server asking the client for something. An
 * `InteractionResponse` counterpart exists, so these belong to the family that
 * expects a reply; an unanswered one may be the same stall the exec refusal was.
 */
export function decodeInteractionQuery(bytes) {
	const reader = new Reader(bytes);
	const out = { id: 0, kind: "unknown" };
	const kinds = new Map([
		[2, "web_search_request"],
		[3, "ask_question"],
		[4, "switch_mode"],
		[7, "create_plan"],
		[8, "setup_vm_environment"],
		[9, "web_fetch"],
		[10, "pr_management"],
		[11, "mcp_auth"],
		[12, "generate_image"],
		[13, "replace_env"],
		[14, "connect_scm"],
	]);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 0) out.id = reader.varint();
		else if (wireType === 2) {
			const payload = reader.bytes();
			const kind = kinds.get(field);
			if (kind) out.kind = kind;
			void payload;
		} else reader.skip(wireType);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * One bidirectional agent run over HTTP/2.
 *
 * Writes Connect-framed `AgentClientMessage`s and surfaces `AgentServerMessage`
 * frames through an async iterator, keeping the run alive with heartbeats.
 */
export class AgentRun {
	#session;
	#stream;
	#reader = new ConnectFrameReader();
	#heartbeat;
	#lastActivity;
	#lastContent;
	#ended = false;
	#closed = false;

	constructor(
		accessToken,
		{ signal, idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS, progressTimeoutMs = STREAM_PROGRESS_TIMEOUT_MS } = {},
	) {
		this.progressTimeoutMs = progressTimeoutMs;
		this.signal = signal;
		this.idleTimeoutMs = idleTimeoutMs;
		this.accessToken = accessToken;
	}

	/** Open the stream and send the run request plus the tool context. */
	async start({ runRequestBytes, tools = [] }) {
		const url = `${CURSOR_BASE_URL}${CURSOR_RUN_PATH}`;
		const target = new URL(url);
		this.#session = http2.connect(target.origin);
		this.#session.on("error", (error) => this.#reader.fail(error));

		this.#stream = this.#session.request({
			":method": "POST",
			":path": target.pathname,
			...AGENT_HEADERS,
			authorization: `Bearer ${this.accessToken}`,
		});

		const status = await new Promise((resolve, reject) => {
			this.#stream.once("response", resolve);
			this.#stream.once("error", reject);
		});
		if (status[":status"] !== 200) {
			this.close();
			throw new CursorError(`Cursor rejected the run (HTTP ${status[":status"]})`, "CURSOR_HTTP");
		}
		const contentType = String(status["content-type"] ?? "");
		if (!/^application\/connect\+proto(?:\s*;|\s*$)/i.test(contentType)) {
			this.close();
			throw new CursorError("Cursor returned a non-Connect response", "CURSOR_PROTOCOL");
		}

		this.#stream.on("data", (chunk) => {
			this.#lastActivity = Date.now();
			this.#reader.push(new Uint8Array(chunk));
		});
		this.#stream.on("end", () => this.#reader.finish());
		this.#stream.on("error", (error) => this.#reader.fail(error));
		this.#stream.on("close", () => {
			this.#closed = true;
			this.#reader.finish();
		});

		this.#lastActivity = Date.now();
		this.#lastContent = Date.now();

		// Tool schemas are NOT pushed here. Cursor asks for them with a
		// `request_context_args` exec and expects a reply on the same stream; an
		// unsolicited top-level push lands in the run_request oneof slot and is
		// overwritten by the real run message a moment later.
		this.#write(encodeRunMessage(runRequestBytes));

		this.#heartbeat = setInterval(() => this.#writeHeartbeat(), HEARTBEAT_INTERVAL_MS);
		this.#heartbeat.unref?.();
	}

	#writeHeartbeat() {
		// AgentClientMessage { client_heartbeat = 7 }. Field 1 is run_request, so a
		// varint there is a malformed message, not a keep-alive.
		try {
			this.#write(new Writer().message(7, new Uint8Array(0)).finish());
		} catch {
			// The stream is already gone; the reader will report the real error.
		}
	}

	/**
	 * Refuse an exec this build does not implement.
	 *
	 * Answered on the exec's *own* field number: the server routes the reply by
	 * that slot, so silence leaves the run waiting forever. Cursor adds exec
	 * variants without notice, and every coherent reply — even a refusal —
	 * resumes the run, which is what lets the model fall back to the tools that
	 * do exist.
	 */
	rejectExec(id, execId, field, reason) {
		this.#write(
			encodeExecClientMessageEnvelope(
				encodeExecClientMessage(id, execId, field, encodeMcpError(reason)),
			),
		);
	}

	#write(payload) {
		if (this.#closed || this.#stream.destroyed) return;
		this.#stream.write(frameEncode(payload));
	}

	/**
	 * Write a client message onto the open run.
	 *
	 * The blob/KV handshake and the tool-result replies both need to write back
	 * onto the same stream mid-run, which is why this is public.
	 */
	writeMessage(payload) {
		this.#write(payload);
	}

	/**
	 * Answer an exec request on the open stream.
	 *
	 * Cursor asks for its tool context as an exec (field 10) rather than
	 * accepting a bare top-level push, and silence here stalls the run.
	 */
	sendToolDefinitions(id, execId, tools) {
		const payload = encodeExecClientMessageEnvelope(
			encodeExecClientMessage(id, execId, 10, encodeRequestContextResult(tools)),
		);
		if (process.env.CURSOR_SHIM_DEBUG) {
			process.stderr.write(
				`cursor-subscription: sent ${tools.length} tool definitions on field 10 ` +
					`(${payload.length} bytes, stream destroyed=${this.#stream?.destroyed})\n`,
			);
		}
		this.#write(payload);
	}

	/** End the run. Safe to call more than once. */
	end() {
		if (this.#ended) return;
		this.#ended = true;
		if (this.#heartbeat) clearInterval(this.#heartbeat);
		try {
			this.#stream?.end(frameEncode(new Uint8Array(0), CONNECT_END_STREAM_FLAG));
		} catch {
			// Already gone.
		}
	}

	/** Tear down the whole session. */
	close() {
		if (this.#heartbeat) clearInterval(this.#heartbeat);
		try {
			this.#stream?.close(http2.constants.NGHTTP2_NO_ERROR);
		} catch {
			// ignore
		}
		try {
			this.#session?.close();
			this.#session?.destroy();
		} catch {
			// ignore
		}
		this.#closed = true;
	}

	/**
	 * Iterate decoded server frames until the run ends.
	 * @returns {AsyncGenerator<{kind: string, payload: any}>}
	 */
	async *frames() {
		for (;;) {
			if (this.signal?.aborted) return;
			if (Date.now() - this.#lastActivity > this.idleTimeoutMs) {
				throw new CursorError("Cursor stopped responding", "CURSOR_IDLE_TIMEOUT");
			}
			// A distinct failure from the one above, and worth distinguishing: the
			// socket can be perfectly alive while no complete frame arrives, because
			// a frame is still being assembled. `#lastContent` and this timeout were
			// both declared and neither was read — the watchdog was half-built.
			if (Date.now() - this.#lastContent > this.progressTimeoutMs) {
				throw new CursorError(
					`Cursor sent no complete frame for ${Math.round(this.progressTimeoutMs / 1000)}s`,
					"CURSOR_PROGRESS_TIMEOUT",
				);
			}
			const frame = await this.#reader.next({ timeoutMs: 250 });
			if (frame === TIMED_OUT) continue;
			// `next()` only returns undefined once the reader has ended AND its
			// queue is drained, so this is end-of-stream. `continue` here would
			// re-enter on an already-resolved promise and starve the event loop.
			if (frame === undefined) return;
			if ((frame.flags & CONNECT_END_STREAM_FLAG) !== 0) return;
			this.#lastContent = Date.now();
			yield frame.payload;
		}
	}

}

/**
 * Discover the models the current account may use.
 *
 * The body is the raw (unframed) empty protobuf message. Cursor may answer with
 * either raw protobuf or Connect frames, so both are tried.
 */
export async function fetchUsableModels(accessToken, { fetchImpl, signal } = {}) {
	const doFetch = fetchImpl ?? globalThis.fetch;
	const response = await doFetch(`${CURSOR_BASE_URL}${CURSOR_MODELS_PATH}`, {
		method: "POST",
		redirect: "error",
		headers: {
			"content-type": "application/proto",
			authorization: `Bearer ${accessToken}`,
			"x-ghost-mode": "true",
			"x-cursor-client-version": AGENT_HEADERS["x-cursor-client-version"],
			"x-cursor-client-type": "cli",
		},
		body: new Uint8Array(0),
		signal,
	});
	if (!response.ok) {
		throw new CursorError(`Cursor model discovery failed (HTTP ${response.status})`, "CURSOR_HTTP");
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length === 0) throw new CursorError("Cursor model discovery returned an empty response");

	const direct = decodeUsableModels(bytes);
	if (direct.length > 0) return direct;

	const reader = new ConnectFrameReader();
	reader.push(bytes);
	reader.finish();
	const models = [];
	for (;;) {
		const frame = await reader.next();
		if (frame === undefined) break;
		if ((frame.flags & CONNECT_END_STREAM_FLAG) !== 0) break;
		models.push(...decodeUsableModels(frame.payload));
	}
	return models;
}

/** A model's id, whether it arrived as a string or a decoded object. */
function nameOf(model) {
	return typeof model === "string" ? model : String(model?.name ?? "");
}

/** Just the ids, for callers that do not care about capabilities. */
export function modelIds(models) {
	return models.map(nameOf).filter((id) => id.length > 0);
}

/** Sort models by name so the picker is stable regardless of Cursor's order. */
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
export function sortModelsByName(models) {
	return [...models].sort((a, b) => collator.compare(nameOf(a), nameOf(b)));
}

export { concatBytes };
