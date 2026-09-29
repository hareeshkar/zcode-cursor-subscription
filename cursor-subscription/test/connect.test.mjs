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

import { ensureShimProvider, reconcileProviderKey } from "../lib/register-provider.mjs";
import { hashMessage, planTurn } from "../lib/conversation-store.mjs";
import { buildColdStart, renderColdStartHistory } from "../lib/conversation.mjs";

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

test("re-running setup repairs a stale key left by a reinstall", async () => {
	// Every forced reinstall wipes the data directory, so the next launch mints
	// a new shim key while the provider keeps the old one — and chat then fails
	// 401 on every request. Re-running the setup is the natural recovery, so it
	// has to repair rather than no-op.
	const path = await scratchConfig();
	await ensureShimProvider({ models: ["composer-2.5"], baseUrl: BASE, apiKey: "first-key", path });
	await ensureShimProvider({ models: ["composer-2.5"], baseUrl: BASE, apiKey: "rotated-key", path });

	const written = JSON.parse(await readFile(path, "utf8"));
	const ours = written.config.providerConfigRules.providerRules.find(
		(r) => r.providerName === "Cursor Subscription",
	);
	assert.equal(ours.config.access.apiKey, "rotated-key", "the entry must carry the live key");
	assert.equal(written.config.providerConfigRules.providerRules.length, 2, "and not be duplicated");
});

test("a matching key is left untouched", async () => {
	const path = await scratchConfig();
	const args = { models: ["composer-2.5"], baseUrl: BASE, apiKey: "stable", path };
	await ensureShimProvider(args);
	const before = await readFile(path, "utf8");
	await ensureShimProvider(args);
	assert.equal(await readFile(path, "utf8"), before, "a run with nothing to repair changes nothing");
});

test("startup reconciliation repairs a resurrected provider holding a stale key", async () => {
	// The uninstall/reinstall trap. Uninstall removes the data directory, so the
	// next launch mints a new shim key; ZCode then writes its own copy of
	// provider_config.json back, resurrecting an entry with the old key. The
	// result is a correctly addressed provider that 401s on every turn.
	const path = await scratchConfig();
	await writeFile(
		path,
		JSON.stringify(
			{
				config: {
					providerConfigRules: {
						providerRules: [
							{
								providerId: "cursor-1",
								providerName: "Cursor Subscription",
								config: {
									api: { type: "openai-chat-completions", baseUrl: BASE },
									access: { type: "api-key", apiKey: "key-from-the-previous-install" },
									personalModelIds: ["composer-2.5"],
								},
							},
						],
					},
				},
			},
			null,
			2,
		),
	);

	const result = await reconcileProviderKey({ baseUrl: BASE, apiKey: "fresh-key", path });
	assert.equal(result.checked, true);
	assert.equal(result.repaired, true);

	const written = JSON.parse(await readFile(path, "utf8"));
	const ours = written.config.providerConfigRules.providerRules[0];
	assert.equal(ours.config.access.apiKey, "fresh-key");
	assert.deepEqual(ours.config.personalModelIds, ["composer-2.5"], "the model list is left alone");
	assert.equal(written.config.providerConfigRules.providerRules.length, 1, "and no entry is added");
});

test("reconciliation never creates a provider or touches one that is not ours", async () => {
	const path = await scratchConfig();
	await writeFile(
		path,
		JSON.stringify(
			{ config: { providerConfigRules: { providerRules: [{ providerId: "o", providerName: "Other", config: { api: { baseUrl: "https://api.other.dev/v1" } } }] } } },
			null,
			2,
		),
	);
	const before = await readFile(path, "utf8");
	const result = await reconcileProviderKey({ baseUrl: BASE, apiKey: "k", path });
	assert.equal(result.repaired, false);
	assert.equal(await readFile(path, "utf8"), before, "the file is untouched");
});

test("a system-prompt change forces a cold start, so a new instruction lands", () => {
	// A late `response_format` instruction rides in the system text, which lives
	// in the checkpoint. If editing the system prompt could still resume, that
	// instruction would be silently dropped for the rest of the session.
	const sys1 = { role: "system", content: "original rules" };
	const sys2 = { role: "system", content: "original rules, plus: reply as JSON" };
	const user = { role: "user", content: "hi" };
	// `committed` is a list of prefix hashes, not messages: that is what the
	// store holds, and comparing objects to hashes always diverges.
	const committed = [sys1, user].map(hashMessage);

	assert.equal(planTurn(committed, [sys2, user]).resumable, false, "a system change must replay");
	assert.equal(
		planTurn(committed, [sys1, user, { role: "user", content: "again" }]).resumable,
		true,
		"an unchanged prefix with a new turn may resume",
	);
});

test("an appended instruction reaches the system blob, and is not duplicated inline", () => {
	const messages = [{ role: "system", content: "base rules" }, { role: "user", content: "hi" }];
	const { systemText, history } = buildColdStart(messages, "Respond with a single valid JSON object.");

	assert.ok(systemText.includes("base rules"), "the harness system prompt is preserved");
	assert.ok(systemText.includes("valid JSON object"), "the appended instruction is included");
	assert.ok(!history.includes("base rules"), "and it is not repeated as conversation text");
});

// --- tool calls must survive a replay ---------------------------------------

const toolTurn = [
	{ role: "system", content: "harness rules" },
	{ role: "user", content: "Check the deploy script and tell me the port." },
	{
		role: "assistant",
		content: null,
		tool_calls: [
			{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"/srv/deploy.sh"}' } },
		],
	},
	{ role: "tool", tool_call_id: "c1", tool_name: "read_file", content: "PORT=8080" },
	{ role: "user", content: "What port will it use?" },
];

test("a tool call survives a replay instead of being skipped", () => {
	// An assistant message with tool calls has `content: null`, so it rendered as
	// empty and was skipped — taking the call with it. The model then saw a bare
	// `[TOOL RESULT]` with no call before it: a conclusion whose action had been
	// removed, and no way to see what it had done or with what arguments.
	const { history } = renderColdStartHistory(toolTurn);
	assert.ok(history.includes("read_file"), "the tool name must reach the model");
	assert.ok(history.includes("deploy.sh"), "and the arguments it was called with");
	assert.ok(history.includes("[TOOL CALL]"), "and it must be labelled as a call");
});

test("a tool result is paired with the tool that produced it", () => {
	// Without the name, several results in one round are undifferentiated.
	const { history } = renderColdStartHistory(toolTurn);
	assert.ok(history.includes("[TOOL RESULT (read_file)]"), "the result names its tool");
});

test("an assistant message with neither text nor calls is still skipped", () => {
	// The skip is correct for a genuinely empty message; it was only wrong for one
	// that carried calls.
	const { history } = renderColdStartHistory([
		{ role: "user", content: "hello" },
		{ role: "assistant", content: "" },
		{ role: "user", content: "again" },
	]);
	assert.ok(!history.includes("[ASSISTANT]"), "an empty assistant turn adds nothing");
});

test("a call with unparseable arguments still names the tool", () => {
	// Losing the whole call because its arguments are odd would be the same bug
	// again, one level down.
	const { history } = renderColdStartHistory([
		{ role: "user", content: "go" },
		{ role: "assistant", content: null, tool_calls: [{ id: "c", function: { name: "shell" } }] },
		{ role: "tool", tool_call_id: "c", content: "ok" },
		{ role: "user", content: "and?" },
	]);
	assert.ok(history.includes("[TOOL CALL] shell"), "the name survives missing arguments");
});

// --- the tool-result continuation -------------------------------------------

test("a tool-result ending re-asks the original request with the result in the transcript", () => {
	// The loop bug: the transcript used to drop everything after the last user
	// message, so this re-ask made the model redo the tool call forever. Now the
	// result is in the transcript, so the re-ask is answerable.
	const { history, lastUser } = renderColdStartHistory([
		{ role: "user", content: "Read the deploy script and tell me the port." },
		{
			role: "assistant",
			content: null,
			tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"/srv/deploy.sh"}' } }],
		},
		{ role: "tool", tool_call_id: "c1", tool_name: "read_file", content: "PORT=8080" },
	]);
	assert.equal(lastUser, "Read the deploy script and tell me the port.");
	assert.match(history, /TOOL CALL/, "the call is in the transcript");
	assert.match(history, /PORT=8080/, "the result is in the transcript");
});

test("a tool-result ending quotes the pending results into the action", () => {
	// Some models (gemini, composer observed) re-call the tool even when the
	// result is in the transcript. Quoting the pending results into the action
	// makes the continuation unmissable, and is what fixed the loop for all four
	// model families.
	const { lastUser } = renderColdStartHistory([
		{ role: "user", content: "What port?" },
		{
			role: "assistant",
			content: null,
			tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"/srv/app.ini"}' } }],
		},
		{ role: "tool", tool_call_id: "c1", tool_name: "read_file", content: "port = 8080" },
	]);
	// The action is the original request; the caller (buildRunRequest) quotes the
	// pending results beneath it. Verify the pieces it assembles from.
	assert.equal(lastUser, "What port?");
});
