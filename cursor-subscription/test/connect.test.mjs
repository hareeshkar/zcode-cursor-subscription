/**
 * Auto-created provider, and honest serving state.
 *
 * The failure these guard against is a tool that reports success while nothing
 * is listening: onboarding that says "connected" and then every completion
 * fails with `fetch failed`.
 *
 * @module cursor-subscription/connect
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureShimProvider } from "../lib/register-provider.mjs";
import { planTurn } from "../lib/conversation-store.mjs";
import { renderColdStartHistory } from "../lib/conversation.mjs";

const BASE = "http://127.0.0.1:8477/v1";

async function scratchConfig() {
	const dir = await mkdtemp(join(tmpdir(), "cursor-connect-"));
	const path = join(dir, "provider_config.json");
	await writeFile(
		path,
		JSON.stringify(
			{
				schemaVersion: 1,
				config: {
					providerOrder: ["other"],
					providerConfigRules: {
						providerRules: [
							{ providerId: "other", providerName: "Other", config: { api: { baseUrl: "https://api.other.dev/v1" }, personalModelIds: ["m"] } },
						],
					},
					modelConfigRules: { providerModelRules: [{ modelId: "m", providerId: "other", config: { enabled: true } }] },
				},
			},
			null,
			2,
		),
	);
	return path;
}

test("the provider is created without the user opening Settings", async () => {
	const path = await scratchConfig();
	const result = await ensureShimProvider({
		models: ["composer-2.5", "grok-4.7-low"],
		baseUrl: BASE,
		apiKey: "shim-key",
		path,
	});

	assert.equal(result.ok, true, result.advice ?? "");
	assert.equal(result.created, true);
	assert.equal(result.apiType, "openai-chat-completions");

	const written = JSON.parse(await readFile(path, "utf8"));
	const rules = written.config.providerConfigRules.providerRules;
	assert.equal(rules.length, 2, "the provider is added alongside the existing one");

	const cursor = rules.find((r) => r.providerName === "Cursor Subscription");
	assert.ok(cursor, "named so it is unambiguous next to Cursor the app");
	assert.equal(cursor.config.api.baseUrl, BASE);
	assert.equal(cursor.config.api.type, "openai-chat-completions");
	assert.equal(cursor.config.access.type, "api-key");
	assert.equal(cursor.config.access.apiKey, "shim-key");
	assert.deepEqual(cursor.config.personalModelIds, ["composer-2.5", "grok-4.7-low"]);

	const modelRules = written.config.modelConfigRules.providerModelRules;
	assert.equal(modelRules.filter((r) => r.providerId === cursor.providerId).length, 2);
	assert.ok(modelRules.some((r) => r.providerId === "other"), "other provider's rules survive");
});

test("a second run updates rather than adding a duplicate provider", async () => {
	const path = await scratchConfig();
	const args = { models: ["composer-2.5"], baseUrl: BASE, apiKey: "shim-key", path };

	const first = await ensureShimProvider(args);
	const second = await ensureShimProvider({ ...args, models: ["composer-2.5", "grok-4.7-low"] });

	assert.equal(first.created, true);
	assert.equal(second.created, false, "the existing entry is reused");
	assert.equal(second.added, 1);

	const written = JSON.parse(await readFile(path, "utf8"));
	const ours = written.config.providerConfigRules.providerRules.filter((r) => r.providerName === "Cursor Subscription");
	assert.equal(ours.length, 1, "still exactly one Cursor provider");
	assert.deepEqual(ours[0].config.personalModelIds, ["composer-2.5", "grok-4.7-low"]);
});

test("a missing config is refused rather than created from scratch", async () => {
	// Creating ZCode's config from nothing could race its own first run.
	const result = await ensureShimProvider({
		models: ["composer-2.5"],
		baseUrl: BASE,
		apiKey: "k",
		path: "/nonexistent/provider_config.json",
	});
	assert.equal(result.ok, false);
	assert.equal(result.reason, "config-missing");
});

test("a moved shim is repaired, not duplicated", async () => {
	const path = await scratchConfig();
	await ensureShimProvider({ models: ["composer-2.5"], baseUrl: "http://127.0.0.1:8480/v1", apiKey: "k", path });
	const result = await ensureShimProvider({ models: ["composer-2.5"], baseUrl: BASE, apiKey: "k", path });

	assert.equal(result.ok, true);
	assert.equal(result.created, false);
	assert.equal(result.baseUrlUpdated, true);

	const written = JSON.parse(await readFile(path, "utf8"));
	const ours = written.config.providerConfigRules.providerRules.filter((r) => r.providerName === "Cursor Subscription");
	assert.equal(ours.length, 1);
	assert.equal(ours[0].config.api.baseUrl, BASE, "the entry follows the shim to its real port");
});

// --- context delivery across a tool round ---------------------------------

const system = { role: "system", content: "system rules" };
const ask1 = { role: "user", content: "read the file" };
const call = { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } };
const withTool = [
	system,
	ask1,
	{ role: "assistant", content: null, tool_calls: [call] },
	{ role: "tool", tool_call_id: "c1", content: "FILE_CONTENTS" },
	{ role: "user", content: "what did it say?" },
];

test("a tool result forces a replay, so it is never dropped on a resumed turn", () => {
	// Resuming would send only the newest user message as the action, and the
	// tool result Cursor never saw would be lost. The interlock has to refuse.
	const plan = planTurn([system, ask1], withTool);
	assert.equal(plan.resumable, false, "must not resume across an unseen tool result");
	assert.equal(plan.suffix.length, withTool.length, "the whole history is the suffix");
});

test("the cold start carries the tool result, labelled as one", () => {
	// The other half of the guarantee: refusing to resume only helps if the
	// replay actually contains the result.
	const { history, lastUser } = renderColdStartHistory(withTool);
	assert.ok(history.includes("FILE_CONTENTS"), "the tool result reaches the model");
	assert.ok(history.includes("[TOOL RESULT]"), "and is distinguishable from a user request");
	assert.equal(lastUser, "what did it say?", "the newest user turn is the action");
});

test("the system prompt is never replayed as conversation text", () => {
	// It is published as a blob instead. Repeating it inline would both waste
	// tokens and let a model treat its own instructions as user content.
	const { history } = renderColdStartHistory(withTool);
	assert.ok(!history.includes("system rules"), "the system prompt is not in the transcript");
});
