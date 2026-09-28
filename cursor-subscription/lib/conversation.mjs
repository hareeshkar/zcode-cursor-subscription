/**
 * Building a Cursor conversation from ZCode's messages.
 *
 * Three things here are load-bearing and were all wrong in the first
 * implementation. Each is documented in docs/RESEARCH-FINDINGS.md and verified
 * against `dsh-cursor-subscription` (MIT, orrinzeng) — see NOTICE.md.
 *
 * **1. The system prompt is the whole harness, and it travels as a blob.**
 *
 * ZCode does not expose skills, project memory, environment facts, output style
 * or context-management policy as tools. `context/builder.ts` assembles all of
 * it into `system` messages, which `system-message-compat.ts` merges into one
 * leading `system` message for OpenAI-compatible providers. That single message
 * *is* the harness. Dropping it — as the first implementation did — leaves the
 * model with no skills, no memory and no environment, while still appearing to
 * work.
 *
 * Cursor's agent protocol has no system role, so the text is published as a blob
 * (`{"role":"system","content":…}`), referenced by id in
 * `root_prompt_messages_json`, and served back when Cursor asks for it.
 *
 * **2. Resumption is checkpoint-based, not id-based.**
 *
 * `AgentServerMessage` field 3 is `conversation_checkpoint_update`; the payload
 * *is* a serialized `ConversationState`. The reference stores it and sends it
 * straight back as the next `conversation_state`. It passes a fresh
 * `conversation_id` on every request — the id is not the anchor.
 *
 * **3. Field-8 turns are blob ids on current servers.**
 *
 * > "Never hand-encode field-8 turns: current Cursor servers treat them as blob ids."
 * > "Build a fresh state with root prompt blobs only." — C11 `lib/index.js`
 *
 * So a cold start carries the system prompt as a blob and prior history as
 * labelled text in the action, exactly as the reference does.
 *
 * @module cursor-subscription/conversation
 */

import { createHash, randomUUID } from "node:crypto";

import {
	encodeAgentTurn,
	encodeAssistantStep,
	encodeConversationState,
	encodeConversationTurn,
	encodeHistoryAssistant,
	encodeHistoryTool,
	encodeHistoryUser,
	encodeModelDetails,
	encodeRunRequest,
	encodeUserMessage,
	encodeUserMessageAction,
	encodeUserMessageActionWithHistory,
} from "./cursor-client.mjs";

/** Flatten OpenAI content (string or parts) into text plus data-URL images. */
export function flattenContent(content) {
	if (typeof content === "string") return { text: content, images: [] };
	if (!Array.isArray(content)) return { text: "", images: [] };
	const parts = [];
	const images = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
		else if (part.type === "image_url") {
			const url = part.image_url?.url;
			if (typeof url === "string" && url.startsWith("data:")) {
				const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
				if (match) images.push({ mimeType: match[1], data: match[2] });
			}
		}
	}
	return { text: parts.join("\n"), images };
}

/**
 * Collect the harness system prompt.
 *
 * Everything ZCode put in a `system` or `developer` message, in order. This is
 * the capability surface: skills, memory index, environment, git context,
 * output style, compaction policy.
 */
export function collectSystemText(messages) {
	const parts = [];
	for (const message of messages) {
		const role = message?.role;
		if (role !== "system" && role !== "developer") continue;
		const { text } = flattenContent(message.content);
		if (text.trim().length > 0) parts.push(text.trim());
	}
	return parts.join("\n\n");
}

/**
 * Render one tool call as a line the model can read.
 *
 * Text rather than the protocol's typed `ConversationHistoryToolCall`, which
 * carries `tool_call_id`, `tool_name` and `args_json`. The typed form is the
 * better answer and is not wired up yet; this stops the call from being lost.
 */
function renderToolCall(call) {
	const fn = call?.function;
	const name = typeof fn?.name === "string" ? fn.name : "";
	if (name.length === 0) return "";
	const args = typeof fn?.arguments === "string" ? fn.arguments : "";
	return args.length > 0 ? `[TOOL CALL] ${name} ${args}` : `[TOOL CALL] ${name}`;
}

/** Label a prior message for the cold-start transcript, as the reference does. */
function coldStartLabel(message) {
	if (message?.role === "assistant") return "ASSISTANT";
	if (message?.role === "tool") {
		// ZCode sends the tool name on the result, so the pairing survives even
		// when several tools ran in one round.
		const name = typeof message?.tool_name === "string" ? message.tool_name.trim() : "";
		return name.length > 0 ? `TOOL RESULT (${name})` : "TOOL RESULT";
	}
	return "USER";
}


/**
 * Convert host messages into Cursor's native history messages.
 *
 * The alternative — and what this replaces — is to flatten everything into a
 * labelled text transcript inside the action. That is lossy in a way that
 * matters: a tool call becomes a sentence the model must interpret rather than a
 * call it can recognise, reasoning is dropped, and the call/result pairing is
 * inferred from adjacency instead of carried by an id.
 *
 * Returns prepared `ConversationHistoryMessage` bytes, skipping the system
 * prompt (published as a blob) and the newest user turn (which is the action).
 *
 * @param {Array} messages the host's OpenAI message array.
 * @param {object} [options]
 * @param {number} [options.until] index to stop before; defaults to the newest user turn.
 */
export function buildStructuredHistory(messages, { until } = {}) {
	const cutoff = until ?? lastUserIndex(messages);
	const history = [];
	if (cutoff <= 0) return history;

	for (let i = 0; i < cutoff; i += 1) {
		const message = messages[i];
		const role = message?.role;
		if (role === "system" || role === "developer") continue;

		if (role === "user") {
			const { text, images } = flattenContent(message.content);
			if (text.trim().length === 0 && images.length === 0) continue;
			history.push(encodeHistoryUser({ text: text.trim(), images }));
			continue;
		}

		if (role === "assistant") {
			const { text } = flattenContent(message.content);
			const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
			const toolCalls = calls
				.map((call) => ({
					toolCallId: typeof call?.id === "string" ? call.id : "",
					toolName: typeof call?.function?.name === "string" ? call.function.name : "",
					argsJson: typeof call?.function?.arguments === "string" ? call.function.arguments : "{}",
				}))
				.filter((call) => call.toolName.length > 0);
			// Reasoning is not carried by the host's message shape; it stays empty
			// rather than being invented.
			if (text.trim().length === 0 && toolCalls.length === 0) continue;
			history.push(encodeHistoryAssistant({ text: text.trim(), toolCalls }));
			continue;
		}

		if (role === "tool") {
			const { text } = flattenContent(message.content);
			history.push(
				encodeHistoryTool({
					toolCallId: typeof message.tool_call_id === "string" ? message.tool_call_id : "",
					toolName: typeof message.tool_name === "string" ? message.tool_name : "",
					text,
					isError: message.is_error === true,
				}),
			);
		}
	}
	return history;
}

/** Index of the newest user message, or -1. */
function lastUserIndex(messages) {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (messages[i]?.role === "user") return i;
	}
	return -1;
}

/**
 * Render prior history as labelled text for a cold start.
 *
 * The action is the only place a cold start can carry history, because
 * field-8 turns are not usable on current servers. Labelling keeps the model
 * able to tell a tool result from a user request.
 */
export function renderColdStartHistory(messages) {
	const entries = [];
	for (const message of messages) {
		const role = message?.role;
		if (role === "system" || role === "developer") continue;

		const { text } = flattenContent(message.content);
		const trimmed = text.trim();
		const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];

		// An assistant message that made tool calls has `content: null`, so it used
		// to render as empty and be skipped — taking the calls with it. The model
		// then received `[TOOL RESULT]` blocks with no call before them: a
		// conclusion with the action removed, unable to see what it had done or
		// with what arguments, and unable to build on it.
		if (trimmed.length === 0 && calls.length === 0) continue;

		const rendered = calls.map(renderToolCall).filter((line) => line.length > 0);
		const body = [trimmed, ...rendered].filter((part) => part.length > 0).join("\n");
		if (body.length === 0) continue;
		entries.push({ label: coldStartLabel(message), text: body });
	}
	if (entries.length === 0) return { history: "", lastUser: "" };

	// The newest user message is the request being answered now, so it becomes
	// the action rather than part of the replayed transcript.
	const lastUserIndex = entries.map((e) => e.label).lastIndexOf("USER");
	const lastUser = lastUserIndex === -1 ? "" : entries[lastUserIndex].text;
	const prior = lastUserIndex === -1 ? entries : entries.slice(0, lastUserIndex);
	if (prior.length === 0) return { history: "", lastUser };

	const history = [
		"Continue the conversation below. Treat entries according to their labels. " +
			"Respond to the final USER request; RUNTIME CONTEXT and TOOL RESULT entries provide context only.",
		...prior.map((entry) => `[${entry.label}]\n${entry.text}`),
	].join("\n\n");
	return { history, lastUser };
}

/** The newest user message — the request Cursor is being asked to answer now. */
export function lastUserMessage(messages) {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (messages[i]?.role !== "user") continue;
		return flattenContent(messages[i].content);
	}
	return { text: "", images: [] };
}

/** Publish the system prompt as a blob and build a cold-start conversation state. */
export function buildColdStart(messages, extraSystem = "") {
	const systemText = [collectSystemText(messages), extraSystem]
		.filter((part) => part.trim().length > 0)
		.join("\n\n");
	const blobStore = new Map();
	const rootPromptBlobIds = [];

	if (systemText.length > 0) {
		const payload = new TextEncoder().encode(
			JSON.stringify({ role: "system", content: systemText }),
		);
		const id = new Uint8Array(createHash("sha256").update(payload).digest());
		// Keyed by hex, matching `Buffer.from(blobId).toString("hex")` on the
		// serving side when Cursor asks for the blob back.
		blobStore.set(Buffer.from(id).toString("hex"), payload);
		rootPromptBlobIds.push(id);
	}

	const { history, lastUser } = renderColdStartHistory(messages);
	return {
		conversationState: encodeConversationState({ rootPromptBlobIds, turns: [] }),
		blobStore,
		systemText,
		history,
		lastUser,
	};
}

/**
 * Build the run request for one turn.
 *
 * With a checkpoint, the checkpoint *is* the conversation state — it already
 * encodes every prior turn — so the request carries only the new action. On a
 * cold start the state is root-prompt blobs only and the history rides in the
 * action text.
 *
 * @param {object} input
 * @param {Array} input.messages   the full OpenAI message array from the host.
 * @param {Uint8Array} [input.checkpoint] conversation state Cursor returned last turn.
 * @param {Map<string, Uint8Array>} input.blobStore blobs to serve during the run.
 * @param {string} input.model     the Cursor model id.
 * @returns {Uint8Array} an `AgentClientMessage`.
 */
export function buildRunRequest({ messages, checkpoint, blobStore, model, extraSystem = "", mcpTools = [], structuredHistory = false, turnsInState = false }) {
	let conversationState;
	let actionText;
	let images;

	if (turnsInState && checkpoint === undefined) {
		// The literal experiment: prior turns in ConversationState.turns as
		// blob-published ids (the reference warns hand-encoded turns are treated as
		// blob ids, and real checkpoints carry 32-byte ids there), with
		// UserMessageAction.conversation_history left EMPTY. Nothing else varies.
		const prior = buildStructuredHistory(messages);
		void prior;
		const cold = buildColdStart(messages, extraSystem);
		conversationState = cold.conversationState;
		if (blobStore) {
			for (const [key, value] of cold.blobStore) blobStore.set(key, value);
		}
		actionText = cold.lastUser;
		images = lastUserMessage(messages).images;
		const turnIds = [];
		for (let i = 0; i < messages.length - 1; i += 1) {
			const message = messages[i];
			if (message?.role !== "user") continue;
			const next = messages[i + 1];
			if (next?.role !== "assistant") continue;
			const userBytes = encodeUserMessage({ text: String(message.content ?? ""), messageId: randomUUID() });
			const assistantStep = encodeAssistantStep(String(next.content ?? ""));
			const turn = encodeConversationTurn(encodeAgentTurn({ userMessage: userBytes, steps: [assistantStep] }));
			// Publish the turn as a blob and reference it by id — the way the root
			// prompt already travels.
			const id = new Uint8Array(createHash("sha256").update(turn).digest());
			if (blobStore) blobStore.set(Buffer.from(id).toString("hex"), turn);
			turnIds.push(id);
		}
		return encodeRunRequest({
			conversationState: encodeConversationState({
				rootPromptBlobIds: [...(cold.conversationState ? [] : [])],
				turns: turnIds,
			}),
			action: encodeUserMessageAction(encodeUserMessage({ text: actionText, messageId: randomUUID() }), []),
			modelDetails: encodeModelDetails(model),
			conversationId: randomUUID(),
			mcpTools,
			clientSupportsInlineImages: images.length > 0,
		});
	}

	if (structuredHistory && checkpoint === undefined) {
		// Prior turns travel as native messages rather than as a transcript inside
		// the action, and the action carries only the newest user turn.
		const history = buildStructuredHistory(messages);
		const cold = buildColdStart(messages, extraSystem);
		conversationState = cold.conversationState;
		if (blobStore) {
			for (const [key, value] of cold.blobStore) blobStore.set(key, value);
		}
		actionText = cold.lastUser;
		images = lastUserMessage(messages).images;
		return encodeRunRequest({
			conversationState,
			action: encodeUserMessageActionWithHistory(
				encodeUserMessage({ text: actionText, messageId: randomUUID() }),
				history,
			),
			modelDetails: encodeModelDetails(model),
			conversationId: randomUUID(),
			mcpTools,
			clientSupportsInlineImages: images.length > 0,
		});
	}

	if (checkpoint !== undefined) {
		conversationState = checkpoint;
		const last = lastUserMessage(messages);
		actionText = last.text;
		images = last.images;
	} else {
		const cold = buildColdStart(messages, extraSystem);
		conversationState = cold.conversationState;
		if (blobStore) {
			for (const [key, value] of cold.blobStore) blobStore.set(key, value);
		}
		actionText = [cold.history, cold.lastUser].filter((part) => part.length > 0).join("\n\n");
		images = lastUserMessage(messages).images;
	}

	return encodeRunRequest({
		conversationState,
		action: encodeUserMessageAction(
			encodeUserMessage({ text: actionText, messageId: randomUUID() }),
			images,
		),
		modelDetails: encodeModelDetails(model),
		// A fresh id every time: the checkpoint, not the id, is the anchor.
		conversationId: randomUUID(),
		mcpTools,
		// Declared only when images are actually attached. The flag tells the server
		// this client can handle inline images; setting it unconditionally would
		// claim a capability the request is not exercising.
		clientSupportsInlineImages: images.length > 0,
	});
}
