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
	encodeConversationState,
	encodeModelDetails,
	encodeRunRequest,
	encodeUserMessage,
	encodeUserMessageAction,
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

/** Label a prior message for the cold-start transcript, as the reference does. */
function coldStartLabel(message) {
	if (message?.role === "assistant") return "ASSISTANT";
	if (message?.role === "tool") return "TOOL RESULT";
	return "USER";
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
		if (trimmed.length === 0) continue;
		entries.push({ label: coldStartLabel(message), text: trimmed });
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
export function buildRunRequest({ messages, checkpoint, blobStore, model, extraSystem = "" }) {
	let conversationState;
	let actionText;
	let images;

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
	});
}
