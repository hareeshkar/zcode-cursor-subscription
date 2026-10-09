/**
 * MCP tool output: a list tool's text IS its product.
 *
 * The regression this pins: `cursor_models` called `.join("\n")` on model
 * OBJECTS, so every caller saw `[object Object]` per line and scripted around
 * the tool instead of using it. And `cursor_selftest` fed the same objects to
 * a strings-only selector, which filtered everything out — it probed zero
 * models and reported a broken setup, every time, while looking healthy.
 *
 * @module cursor-subscription/mcp-output
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { formatModelList, modelIds } from "../lib/cursor-client.mjs";
import { pickProbeModels } from "../lib/selftest.mjs";

const MODELS = [
	{ name: "composer-2.5-fast", displayName: "Composer 2.5 Fast", supportsImages: false, supportsThinking: false, contextTokenLimit: 200_000 },
	{ name: "gemini-3.8-flash-medium", displayName: "gemini-3.8-flash-medium", supportsImages: false, supportsThinking: true, contextTokenLimit: 1_000_000 },
	{ name: "grok-4.7-medium", displayName: "Grok 4.7", supportsImages: false, supportsThinking: false, contextTokenLimit: undefined },
];

test("a model list renders names and capabilities, never [object Object]", () => {
	const text = formatModelList(MODELS);
	assert.ok(!text.includes("[object Object]"), "the exact defect this file exists for");
	assert.ok(text.startsWith("3 models available to the signed-in Cursor account"));
	for (const model of MODELS) {
		assert.ok(text.includes(model.name), `${model.name} must appear by name`);
	}
	assert.ok(text.includes("ctx 1M"), "a million-token context reads as 1M");
	assert.ok(text.includes("ctx 200k"), "a 200k context reads as 200k");
	assert.ok(text.includes("thinking"), "a declared capability is shown");
	assert.ok(!text.includes("images"), "flags Cursor reports false are not advertised");
	// displayName is shown when it adds information, omitted when it repeats the id
	assert.ok(text.includes("Composer 2.5 Fast"));
	assert.equal((text.match(/gemini-3\.8-flash-medium/g) ?? []).length, 1, "a redundant display name is not printed twice");
});

test("a fallback list says plainly it is not the account's entitlements", () => {
	const text = formatModelList(["composer-2.5", "grok-4.7-medium"], { fallback: true });
	assert.ok(text.includes("FALLBACK"), "the marker is explicit");
	assert.ok(text.includes("NOT your account's entitlements"), "the honesty clause is present");
	assert.ok(text.includes("composer-2.5"));
});

test("an empty list says so instead of rendering a blank body", () => {
	assert.equal(formatModelList([]), "No models were returned.");
});

test("string models still render — the older shape must not break", () => {
	const text = formatModelList(["a-model", "b-model"]);
	assert.ok(text.includes("a-model") && text.includes("b-model"));
	assert.ok(!text.includes("undefined"));
});

test("the self-test selector receives ids, so probes are actually chosen", () => {
	// The second bug: objects into a strings-only selector filtered everything
	// out, so the tool probed zero models and called the setup broken.
	const picked = pickProbeModels(modelIds(MODELS), { limit: 6 });
	assert.ok(picked.length > 0, "the selector must choose from the account's models");
	assert.equal(picked[0], "composer-2.5-fast", "the cheap preferred family still ranks first");
	for (const id of picked) assert.equal(typeof id, "string");
});
