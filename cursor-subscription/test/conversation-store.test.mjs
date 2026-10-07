/**
 * Tests for the pieces where a silent bug would be expensive:
 * the resumption interlock and the wire codecs.
 *
 * Run with: node --test test/
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ConversationStore, hashMessage, planTurn } from "../lib/conversation-store.mjs";
import {
	ConnectFrameReader,
	CONNECT_END_STREAM_FLAG,
	Reader,
	Writer,
	decodeValue,
	encodeValue,
	frameEncode,
	readFields,
} from "../lib/proto.mjs";
import {
	buildColdStart,
	buildRunRequest,
	collectSystemText,
	renderColdStartHistory,
} from "../lib/conversation.mjs";
import { CredentialStore } from "../lib/credentials.mjs";
import { getTokenExpiry, getTokenSub, assertCursorAuthUrl } from "../lib/auth.mjs";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// The resumption interlock
// ---------------------------------------------------------------------------

const user = (text) => ({ role: "user", content: text });
const assistant = (text) => ({ role: "assistant", content: text });
const tool = (text, name = "read") => ({ role: "tool", name, content: text });

test("a plain append resumes", () => {
	const first = [user("a"), assistant("b")];
	const second = [user("a"), assistant("b"), user("c")];
	const committed = first.map((m) => hashMessage(m));
	const plan = planTurn(committed, second);
	assert.equal(plan.resumable, true);
	assert.equal(plan.suffix.length, 1);
	assert.deepEqual(plan.suffix, [user("c")]);
});

test("auto-compaction forces a replay", () => {
	// ZCode replaced a span of history with a summary.
	const before = [user("a"), assistant("b"), user("c"), assistant("d")];
	const after = [user("summary of a..d"), user("c"), assistant("d"), user("e")];
	const plan = planTurn(before.map((m) => hashMessage(m)), after);
	assert.equal(plan.resumable, false);
	assert.equal(plan.reason, "prefix-diverged");
	// A replay sends everything; nothing is silently dropped.
	assert.equal(plan.suffix.length, after.length);
});

test("an edited turn invalidates the prefix", () => {
	const before = [user("a"), assistant("b")];
	const after = [user("a"), assistant("B EDITED"), user("c")];
	const plan = planTurn(before.map((m) => hashMessage(m)), after);
	assert.equal(plan.resumable, false);
});

test("a rewound session forces a replay rather than resuming stale state", () => {
	const before = [user("a"), assistant("b"), user("c")];
	const after = [user("a")];
	const plan = planTurn(before.map((m) => hashMessage(m)), after);
	assert.equal(plan.resumable, false);
	assert.equal(plan.reason, "history-shrank");
});

test("an unchanged message hashes identically across calls", () => {
	// Object key order must not matter, or resumption would break at random.
	assert.equal(hashMessage({ role: "user", content: "x" }), hashMessage({ content: "x", role: "user" }));
});

test("the store finds a live conversation only on an exact prefix match", () => {
	const store = new ConversationStore();
	const messages = [user("a"), assistant("b")];
	store.record(messages, "conv-1");
	assert.equal(store.find(messages)?.conversationId, "conv-1");
	// One extra turn is an extension, so the prefix still matches.
	assert.equal(store.find([...messages, user("c")])?.conversationId, "conv-1");
	// A mutated head does not.
	assert.equal(store.find([user("a!"), assistant("b")]), undefined);
});

test("the store expires conversations past the TTL", () => {
	const store = new ConversationStore({ ttlMs: 1000 });
	const messages = [user("a")];
	store.record(messages, "conv-1", { now: 0 });
	assert.equal(store.find(messages, 500)?.conversationId, "conv-1");
	assert.equal(store.find(messages, 5000), undefined);
});

test("the store forgets an anchor that produced no checkpoint", () => {
	const store = new ConversationStore();
	const messages = [user("a")];
	store.record(messages, "c1", { checkpoint: new Uint8Array([1]) });
	assert.equal(store.size, 1);
	assert.equal(store.forget(messages), true);
	assert.equal(store.size, 0);
});

test("the store evicts beyond its bound", () => {
	const store = new ConversationStore({ max: 2 });
	store.record([user("a")], "c1");
	store.record([user("b")], "c2");
	store.record([user("c")], "c3");
	assert.equal(store.size, 2);
});

// ---------------------------------------------------------------------------
// Wire codecs
// ---------------------------------------------------------------------------

test("varints round-trip through the protobuf writer", () => {
	for (const value of [0, 1, 127, 128, 300, 16383, 16384, 1_000_000]) {
		const bytes = new Writer().varint(1, value).finish();
		const reader = new Reader(bytes);
		assert.deepEqual(reader.tag(), { field: 1, wireType: 0 });
		assert.equal(reader.varint(), value);
	}
});

test("Connect framing survives arbitrary chunk boundaries", async () => {
	const payloads = [
		new Writer().string(1, "hello").finish(),
		new Writer().string(1, "world").finish(),
		new Writer().varint(2, 42).finish(),
	];
	const stream = payloads
		.map((p) => frameEncode(p))
		.concat(frameEncode(new Uint8Array(0), CONNECT_END_STREAM_FLAG));
	const all = Buffer.concat(stream.map((s) => Buffer.from(s)));

	const reader = new ConnectFrameReader();
	// Feed one byte at a time: the worst case a TCP segment can produce.
	for (let i = 0; i < all.length; i += 1) {
		reader.push(new Uint8Array(all.subarray(i, i + 1)));
	}
	reader.finish();

	const seen = [];
	for (;;) {
		const frame = await reader.next();
		if (frame === undefined) break;
		if ((frame.flags & CONNECT_END_STREAM_FLAG) !== 0) break;
		seen.push(Buffer.from(frame.payload).toString("binary"));
	}
	assert.equal(seen.length, 3);
	assert.equal(seen[0], Buffer.from(payloads[0]).toString("binary"));
});

test("google.protobuf.Value round-trips JSON shapes", () => {
	for (const value of [null, true, false, 42, 3.5, "text", [1, "two", null], { a: 1, b: "two", c: [3] }]) {
		assert.deepEqual(decodeValue(encodeValue(value)), value);
	}
});

test("readFields surfaces field numbers for undecoded frames", () => {
	const bytes = new Writer().string(1, "a").varint(4, 7).finish();
	assert.deepEqual(
		readFields(bytes).map((f) => f.field),
		[1, 4],
	);
});

// ---------------------------------------------------------------------------
// Conversation construction
// ---------------------------------------------------------------------------

test("the harness system prompt is collected, not dropped", () => {
	// This is the regression that matters most: ZCode packs skills, memory,
	// environment and output style into system messages, and dropping them leaves
	// the model working but blind.
	const messages = [
		{ role: "system", content: "You are ZCode. Skills: a, b, c." },
		{ role: "system", content: "Project memory index follows." },
		{ role: "user", content: "hi" },
	];
	const system = collectSystemText(messages);
	assert.ok(system.includes("Skills: a, b, c."));
	assert.ok(system.includes("Project memory index"));
});

test("a cold start publishes the system prompt as a root prompt blob", () => {
	const messages = [
		{ role: "system", content: "HARNESS INSTRUCTIONS" },
		{ role: "user", content: "first question" },
	];
	const cold = buildColdStart(messages);
	// Root prompt blobs live on ConversationStateStructure field 1.
	assert.deepEqual(readFields(cold.conversationState).map((f) => f.field), [1]);
	assert.equal(cold.blobStore.size, 1);
	assert.equal(cold.lastUser, "first question");
	// The blob is addressable by the hex of its sha256, which is how the
	// serving side looks it up.
	const [key, payload] = [...cold.blobStore][0];
	assert.match(key, /^[0-9a-f]{64}$/);
	assert.deepEqual(JSON.parse(new TextDecoder().decode(payload)), {
		role: "system",
		content: "HARNESS INSTRUCTIONS",
	});
});

test("a cold start renders prior history as labelled text", () => {
	const { history, lastUser } = renderColdStartHistory([
		{ role: "system", content: "ignored" },
		{ role: "user", content: "older question" },
		{ role: "assistant", content: "older answer" },
		{ role: "tool", name: "read", content: "file contents" },
		{ role: "user", content: "current question" },
	]);
	assert.equal(lastUser, "current question");
	assert.ok(history.includes("[USER]\nolder question"));
	assert.ok(history.includes("[ASSISTANT]\nolder answer"));
	assert.ok(history.includes("[TOOL RESULT]\nfile contents"));
	// The current request is the action, never replayed history.
	assert.ok(!history.includes("current question"));
});

test("a cold start writes no field-8 turns", () => {
	// Current Cursor servers read field 8 as blob ids, so a cold start must not
	// hand-encode turns there.
	const cold = buildColdStart([
		{ role: "system", content: "sys" },
		{ role: "user", content: "q" },
	]);
	assert.ok(!readFields(cold.conversationState).some((f) => f.field === 8));
});

test("a checkpoint replaces the conversation state entirely", () => {
	const checkpoint = new Writer().bytes(1, new Uint8Array([1, 2, 3])).finish();
	const request = buildRunRequest({
		messages: [
			{ role: "system", content: "sys" },
			{ role: "user", content: "second question" },
		],
		checkpoint,
		blobStore: new Map(),
		model: "composer-2",
	});
	// AgentRunRequest { conversation_state=1, action=2, model_details=3, conversation_id=5 }
	assert.deepEqual(readFields(request).map((f) => f.field), [1, 2, 3, 5]);
	const state = readFields(request).find((f) => f.field === 1).bytes;
	assert.deepEqual(Array.from(state), Array.from(checkpoint));
});

test("the conversation id is fresh on every run", () => {
	// The checkpoint, not the id, is the resumption anchor.
	const args = {
		messages: [{ role: "user", content: "q" }],
		blobStore: new Map(),
		model: "composer-2",
	};
	const a = buildRunRequest(args);
	const b = buildRunRequest(args);
	const idOf = (bytes) => new TextDecoder().decode(readFields(bytes).find((f) => f.field === 5).bytes);
	assert.notEqual(idOf(a), idOf(b));
});

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

function makeJwt(payload) {
	const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

test("token expiry reads the JWT exp claim", () => {
	const token = makeJwt({ exp: 1_700_000_000 });
	assert.equal(getTokenExpiry(token), 1_700_000_000_000);
});

test("token expiry falls back for an unreadable JWT", () => {
	assert.equal(getTokenExpiry("not-a-jwt", () => 0), 24 * 60 * 60 * 1000);
});

test("token sub strips the identity-provider prefix", () => {
	assert.equal(getTokenSub(makeJwt({ sub: "github|user_123" })), "user_123");
	assert.equal(getTokenSub(makeJwt({ sub: "user_123" })), "user_123");
	assert.equal(getTokenSub("garbage"), undefined);
});

test("the auth URL is pinned to https cursor.com", () => {
	assert.ok(assertCursorAuthUrl("https://cursor.com/loginDeepControl?x=1"));
	assert.throws(() => assertCursorAuthUrl("http://cursor.com/x"));
	assert.throws(() => assertCursorAuthUrl("https://evil.example/x"));
	assert.throws(() => assertCursorAuthUrl("https://user:pass@cursor.com/x"));
});

// ---------------------------------------------------------------------------
// Credential store
// ---------------------------------------------------------------------------

test("credentials are written 0600 and read back", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cursor-cred-"));
	const store = new CredentialStore({ dir, path: join(dir, "credentials.json") });
	assert.equal(await store.read(), undefined);

	await store.save({ type: "oauth", access: "a", refresh: "r", expires: 123, sub: "u" });
	const current = await store.read();
	assert.equal(current.access, "a");
	assert.equal(current.sub, "u");

	const mode = (await stat(join(dir, "credentials.json"))).mode & 0o777;
	assert.equal(mode, 0o600, "credential file must not be readable by others");
});

test("status never leaks token material", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cursor-cred-"));
	const store = new CredentialStore({ dir, path: join(dir, "credentials.json") });
	await store.save({ type: "oauth", access: "SECRET", refresh: "ALSOSECRET", expires: 5, sub: "u" });
	const serialised = JSON.stringify(await store.status());
	assert.ok(!serialised.includes("SECRET"));
	assert.equal((await store.status()).authenticated, true);
});

test("a stale refresh does not clobber a newer rotation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cursor-cred-"));
	const store = new CredentialStore({ dir, path: join(dir, "credentials.json") });
	await store.save({ type: "oauth", access: "a1", refresh: "r1", expires: 1, sub: "u" });
	// Another run rotated first.
	await store.modify("r1", () => ({ type: "oauth", access: "a2", refresh: "r2", expires: 2, sub: "u" }));
	// Our stale update must be rejected.
	const result = await store.modify("r1", () => ({ type: "oauth", access: "STALE", refresh: "r3", expires: 3, sub: "u" }));
	assert.equal(result.access, "a2");
	const raw = await readFile(join(dir, "credentials.json"), "utf8");
	assert.ok(!raw.includes("STALE"));
});

test("clearing removes the credential", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cursor-cred-"));
	const store = new CredentialStore({ dir, path: join(dir, "credentials.json") });
	await store.save({ type: "oauth", access: "a", refresh: "r", expires: 1 });
	await store.clear();
	assert.equal(await store.read(), undefined);
});

// ---------------------------------------------------------------------------
// Probe-model selection
// ---------------------------------------------------------------------------

test("probe selection avoids expensive model families", async () => {
	const { pickProbeModels } = await import("../lib/selftest.mjs");
	const models = [
		"claude-opus-5-5-high",
		"claude-sonnet-5-thinking-high",
		"gpt-5.6-sol-high",
		"gpt-5.4-nano-low",
		"composer-2.5",
		"kimi-k3-low",
		"grok-4.7-low",
		"gemini-3.6-flash-low",
		"muse-spark-1.3-low",
	];
	const picked = pickProbeModels(models, { limit: 20 });
	assert.ok(!picked.some((m) => /claude|gpt|opus|sonnet/i.test(m)), "premium families must be skipped");
	assert.ok(picked.includes("kimi-k3-low"));
	assert.ok(picked.includes("composer-2.5"));
});

test("probe selection prefers Composer, then Grok, then the rest", async () => {
	const { pickProbeModels } = await import("../lib/selftest.mjs");
	const models = [
		"gemini-3.8-flash-low",
		"kimi-k3-low",
		"grok-4.7-high",
		"grok-4.7-low",
		"composer-2.5",
		"composer-2.5-fast",
		"muse-spark-1.3-low",
	];
	const picked = pickProbeModels(models, { limit: 7 });
	// Composer before Grok before everything else, regardless of cost.
	assert.ok(picked.indexOf("composer-2.5-fast") < picked.indexOf("composer-2.5"), "cheap composer first");
	assert.ok(picked.indexOf("composer-2.5") < picked.indexOf("grok-4.7-low"), "composer before grok");
	assert.ok(picked.indexOf("grok-4.7-low") < picked.indexOf("grok-4.7-high"), "cheap grok before pricey grok");
	assert.ok(picked.indexOf("grok-4.7-high") < picked.indexOf("gemini-3.8-flash-low"), "grok before other tiers");
	assert.equal(picked[0], "composer-2.5-fast");
});

test("probe selection honours the limit", async () => {
	const { pickProbeModels } = await import("../lib/selftest.mjs");
	const models = ["composer-2.5", "composer-2.5-fast", "kimi-k3-high", "kimi-k3-low", "glm-5.3-codex"];
	const picked = pickProbeModels(models, { limit: 2 });
	assert.equal(picked.length, 2);
	// Family preference outranks cost: both Composer models beat kimi-k3-low,
	// with the cheap variant first.
	assert.deepEqual(picked, ["composer-2.5-fast", "composer-2.5"]);
});

test("probe selection is not hardcoded to one model", async () => {
	const { pickProbeModels } = await import("../lib/selftest.mjs");
	// A completely different catalogue must still yield probes.
	const picked = pickProbeModels(["brand-new-small-a", "brand-new-flash-low"], { limit: 4 });
	assert.deepEqual(picked.sort(), ["brand-new-flash-low", "brand-new-small-a"]);
});

test("a continuation turn carries the model's own history, not just bare results", () => {
	// The regression that broke every deep agent loop: when the last message
	// was a tool result, the action sent the original task plus quoted results
	// but DROPPED the transcript — so on round N the model had results with no
	// record of the calls it had already made, and re-issued the same read on
	// every round (four identical Reads of one file, live, across families).
	const messages = [
		{ role: "system", content: "sys" },
		{ role: "user", content: "refactor app.js" },
		{ role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "Read", arguments: '{"file_path":"app.js"}' } }] },
		{ role: "tool", tool_call_id: "c1", content: "first read result" },
		{ role: "assistant", content: null, tool_calls: [{ id: "c2", function: { name: "Read", arguments: '{"file_path":"app.js"}' } }] },
		{ role: "tool", tool_call_id: "c2", content: "second read result" },
	];
	const request = buildRunRequest({ messages, blobStore: new Map(), model: "m" });

	// AgentRunRequest.action = 2 → UserMessageAction(1) → UserMessage(1) → text(1)
	const action = readFields(request).find((f) => f.field === 2).bytes;
	const step = readFields(action).find((f) => f.field === 1).bytes;
	const userMessage = readFields(step).find((f) => f.field === 1).bytes;
	const text = new TextDecoder().decode(readFields(userMessage).find((f) => f.field === 1).bytes);

	assert.ok(text.includes("refactor app.js"), "the original request travels");
	assert.ok(text.includes("[TOOL CALL] Read"), "the model's own prior calls travel");
	assert.ok(text.includes("first read result"), "earlier results stay in the transcript");
	assert.ok(text.includes("[Read result]"), "the newest result is quoted with its tool name, paired by call id");
	assert.ok(!text.includes("[tool result]"), "no nameless fallback when the id pairs");
	assert.ok(
		text.indexOf("first read result") < text.indexOf("second read result"),
		"history precedes the quoted newest round",
	);
	assert.ok(text.includes("Do not repeat a call you already made"));
});
