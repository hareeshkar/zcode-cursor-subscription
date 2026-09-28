/**
 * Port fallback and provider registration.
 *
 * Both exist because the shim may not end up on the port it was configured
 * with. A clash used to crash the whole MCP tool server, and a moved port
 * used to leave the provider pointing at an address nothing answers on.
 *
 * @module cursor-subscription/port-fallback
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { portCandidates } from "../lib/shim.mjs";
import { findShimProvider, registerModels } from "../lib/register-provider.mjs";

test("the configured port is tried first, then the last one that worked", () => {
	const ports = portCandidates(9100, { recorded: 8480, span: 5 });
	assert.equal(ports[0], 9100, "configured port wins");
	assert.equal(ports[1], 8480, "recorded port is the next best guess");
	assert.equal(new Set(ports).size, ports.length, "no duplicates");
});

test("candidates stay inside the scan window around the default", () => {
	const ports = portCandidates(8477, { span: 4 });
	assert.deepEqual(ports, [8477, 8478, 8479, 8480]);
});

test("a recorded port already in the list is not repeated", () => {
	const ports = portCandidates(8477, { recorded: 8478, span: 4 });
	assert.deepEqual(ports, [8477, 8478, 8479, 8480]);
	assert.equal(new Set(ports).size, ports.length);
});

// --- findShimProvider ------------------------------------------------------

const configWith = (providers) => ({
	config: { providerConfigRules: { providerRules: providers } },
});

test("a shim provider is found by base URL whatever it is named", () => {
	const config = configWith([
		{
			providerId: "new-provider",
			providerName: "My Cursor",
			config: { api: { baseUrl: "http://127.0.0.1:8477/v1" } },
		},
	]);
	const found = findShimProvider(config, "http://127.0.0.1:8477/v1");
	assert.equal(found.providerId, "new-provider");
});

test("a shim is still found after it has moved to another port", () => {
	const config = configWith([
		{ providerId: "p1", providerName: "Cursor", config: { api: { baseUrl: "http://127.0.0.1:8477/v1" } } },
	]);
	const found = findShimProvider(config, "http://127.0.0.1:8480/v1");
	assert.equal(found.providerId, "p1", "a moved shim is still recognised by its host");
});

test("a non-loopback provider is never claimed as the shim", () => {
	const config = configWith([
		{ providerId: "api.openai.com", providerName: "OpenAI", config: { api: { baseUrl: "https://api.openai.com/v1" } } },
	]);
	assert.equal(findShimProvider(config, "http://127.0.0.1:8477/v1"), undefined);
});

test("an exact match wins over another loopback provider", () => {
	const config = configWith([
		{ providerId: "stale", providerName: "Stale", config: { api: { baseUrl: "http://127.0.0.1:8477/v1" } } },
		{ providerId: "live", providerName: "Live", config: { api: { baseUrl: "http://127.0.0.1:8480/v1" } } },
	]);
	assert.equal(findShimProvider(config, "http://127.0.0.1:8480/v1").providerId, "live");
});

test("a provider on a different path is not claimed", () => {
	const config = configWith([
		{ providerId: "other", providerName: "Other", config: { api: { baseUrl: "http://127.0.0.1:8477/api" } } },
	]);
	assert.equal(findShimProvider(config, "http://127.0.0.1:8477/v1"), undefined);
});

// --- registerModels --------------------------------------------------------

async function scratchConfig(providers) {
	const dir = await mkdtemp(join(tmpdir(), "cursor-provider-"));
	const path = join(dir, "provider_config.json");
	await writeFile(path, JSON.stringify(configWith(providers), null, 2));
	return path;
}

test("registration moves the provider to the shim's real port", async () => {
	const path = await scratchConfig([
		{
			providerId: "p1",
			providerName: "Cursor",
			config: {
				api: { type: "openai-chat-completions", baseUrl: "http://127.0.0.1:8477/v1" },
				access: { type: "api-key", apiKey: "keep-me" },
				personalModelIds: [],
			},
		},
	]);

	const result = await registerModels({
		models: ["composer-2.5", "grok-4.7-low"],
		baseUrl: "http://127.0.0.1:8480/v1",
		path,
	});

	assert.equal(result.ok, true);
	assert.equal(result.baseUrlUpdated, true, "the moved port is written back");

	const written = JSON.parse(await readFile(path, "utf8"));
	const rule = written.config.providerConfigRules.providerRules[0];
	assert.equal(rule.config.api.baseUrl, "http://127.0.0.1:8480/v1");
	assert.equal(rule.config.access.apiKey, "keep-me", "the key is never touched");
	assert.equal(rule.config.api.type, "openai-chat-completions", "the api type is preserved");
	assert.deepEqual(rule.config.personalModelIds, ["composer-2.5", "grok-4.7-low"]);

	const rules = written.config.modelConfigRules.providerModelRules;
	assert.equal(rules.length, 2, "each model is mirrored as enabled");
	assert.ok(rules.every((r) => r.providerId === "p1" && r.config.enabled === true));
});

test("registration is idempotent and leaves an unmoved URL alone", async () => {
	const path = await scratchConfig([
		{
			providerId: "p1",
			providerName: "Cursor",
			config: { api: { baseUrl: "http://127.0.0.1:8477/v1" }, personalModelIds: [] },
		},
	]);

	const args = { models: ["composer-2.5"], baseUrl: "http://127.0.0.1:8477/v1", path };
	const first = await registerModels(args);
	assert.equal(first.baseUrlUpdated, false, "an unchanged URL is not rewritten");
	const second = await registerModels(args);

	assert.equal(second.added, 0, "a second run adds nothing");
	const written = JSON.parse(await readFile(path, "utf8"));
	assert.equal(written.config.modelConfigRules.providerModelRules.length, 1, "no duplicate model rules");
});

test("registration refuses when no provider points at the shim", async () => {
	const path = await scratchConfig([
		{ providerId: "x", providerName: "X", config: { api: { baseUrl: "https://api.openai.com/v1" } } },
	]);
	const result = await registerModels({ models: ["composer-2.5"], baseUrl: "http://127.0.0.1:8477/v1", path });
	assert.equal(result.ok, false);
	assert.equal(result.reason, "provider-not-found");
});
