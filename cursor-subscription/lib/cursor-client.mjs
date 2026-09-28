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

/** AgentConversationTurnStructure { user_message = 1, steps = 2 } */
export function encodeAgentTurn(userBytes, stepBytes) {
	const writer = new Writer();
	if (userBytes.length > 0) writer.bytes(1, userBytes);
	for (const step of stepBytes) writer.bytes(2, step);
	return writer.finish();
}

/** ConversationTurnStructure { agent_conversation_turn = 1 } */
export function encodeTurnStructure(turnBytes) {
	return new Writer().message(1, turnBytes).finish();
}

/** ModelDetails { model_id = 1, display_model_id = 3, display_name = 4 } */
export function encodeModelDetails(modelId) {
	const writer = new Writer();
	writer.string(1, modelId);
	writer.string(3, modelId);
	writer.string(4, modelId);
	return writer.finish();
}

/** ConversationHistoryImageContent { data = 1, mime_type = 2 } */
function encodeConversationHistoryImage({ data, mimeType }) {
	const image = new Writer().string(1, data);
	if (mimeType) image.string(2, mimeType);
	const content = new Writer().message(2, image.finish()).finish();
	const user = new Writer().message(1, content).finish();
	return new Writer().message(1, user).finish();
}

/** ConversationHistory { messages = 1 } */
function encodeConversationHistory(images) {
	const writer = new Writer();
	for (const image of images) writer.message(1, encodeConversationHistoryImage(image));
	return writer.finish();
}

/** ConversationAction { user_message_action = 1 } */
export function encodeUserMessageAction(userBytes, images = []) {
	const inner = new Writer().message(1, userBytes);
	if (images.length > 0) inner.message(7, encodeConversationHistory(images));
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
			const base = { id, execId, field };
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

/** Kept for callers that only need the id. */
function decodeModelId(bytes) {
	return decodeAvailableModel(bytes)?.name;
}

/**
 * Split one `AgentServerMessage` payload into its constituent messages.
 *
 * The message is a oneof, so the top-level field number identifies what arrived:
 * 1 interaction update, 2 exec request, 3 conversation checkpoint, 4 KV blob.
 * Field 3 is the resumption anchor — see docs/RESEARCH-FINDINGS.md 6.9.
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
