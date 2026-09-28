/**
 * Diagnosis.
 *
 * The failure worth catching is a provider entry pointing at a port the shim
 * no longer serves: healthy on both sides, broken together, and invisible to
 * anything that only reports its own state.
 *
 * @module cursor-subscription/diagnose
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compareEndpoints, inspectProviderConfig } from "../lib/diagnose.mjs";

async function scratch(config) {
	const path = join(await mkdtemp(join(tmpdir(), "cursor-diagnose-")), "provider_config.json");
	await writeFile(path, JSON.stringify(config, null, 2));
	return path;
}

const withProvider = (baseUrl, models = 2) => ({
	config: {
		providerConfigRules: {
			providerRules: [
				{
					providerId: "cursor-1",
					providerName: "Cursor",
					config: {
						api: { type: "openai-chat-completions", baseUrl },
						personalModelIds: Array.from({ length: models }, (_, i) => `model-${i}`),
					},
				},
			],
		},
		modelConfigRules: { providerModelRules: [{ modelId: "a", providerId: "cursor-1", config: { enabled: true } }] },
	},
});

test("a provider pointing at the wrong port is reported, not called healthy", async () => {
	// The shim moved; the config did not. Both halves look fine alone.
	const path = await scratch(withProvider("http://127.0.0.1:8477/v1"));
	const found = await inspectProviderConfig({ path, baseUrl: "http://127.0.0.1:8480/v1" });

	assert.equal(found.found, true, "a moved shim is still recognised as ours");
	const verdict = compareEndpoints("http://127.0.0.1:8480/v1", found.baseUrl);
	assert.equal(verdict.ok, false);
	assert.match(verdict.detail, /8480/, "the detail names the port that actually works");
	assert.match(verdict.detail, /cursor_register_models/, "and how to fix it");
});

test("a matching provider reports as agreeing", async () => {
	const path = await scratch(withProvider("http://127.0.0.1:8477/v1"));
	const found = await inspectProviderConfig({ path, baseUrl: "http://127.0.0.1:8477/v1" });

	assert.equal(found.found, true);
	assert.equal(found.models, 2);
	assert.equal(found.modelRules, 1);
	assert.equal(compareEndpoints(found.baseUrl, "http://127.0.0.1:8477/v1").ok, true);
});

test("a trailing slash is not treated as a mismatch", async () => {
	const verdict = compareEndpoints("http://127.0.0.1:8477/v1", "http://127.0.0.1:8477/v1/");
	assert.equal(verdict.ok, true);
});

test("a missing provider is reported as missing, never created", async () => {
	const path = await scratch({ config: { providerConfigRules: { providerRules: [] } } });
	const found = await inspectProviderConfig({ path, baseUrl: "http://127.0.0.1:8477/v1" });

	assert.equal(found.found, false);
	assert.equal(compareEndpoints("http://127.0.0.1:8477/v1", found.baseUrl).ok, false);
	assert.match(compareEndpoints("http://127.0.0.1:8477/v1", found.baseUrl).detail, /no Cursor provider/);
});

test("an unreadable config is reported, not thrown", async () => {
	const found = await inspectProviderConfig({ path: "/nonexistent/provider_config.json" });
	assert.equal(found.found, false);
	assert.match(found.error, /could not read/);
});

test("a provider with zero models is visible to the caller", async () => {
	const path = await scratch(withProvider("http://127.0.0.1:8477/v1", 0));
	const found = await inspectProviderConfig({ path, baseUrl: "http://127.0.0.1:8477/v1" });
	assert.equal(found.found, true);
	assert.equal(found.models, 0, "the picker would be empty, which the tool reports as a fault");
});

test("a stale provider key is detected without revealing either secret", async () => {
	const path = await scratch(withProvider("http://127.0.0.1:8477/v1", 2));
	// Give the entry a key at all, then compare against a different one.
	const config = JSON.parse(await readFile(path, "utf8"));
	config.config.providerConfigRules.providerRules[0].config.access = { type: "api-key", apiKey: "old-key" };
	await writeFile(path, JSON.stringify(config, null, 2));

	const stale = await inspectProviderConfig({ path, baseUrl: "http://127.0.0.1:8477/v1", apiKey: "new-key" });
	assert.equal(stale.found, true);
	assert.equal(stale.apiKeyMatches, false, "a reinstalled shim's key must be seen as stale");

	const same = await inspectProviderConfig({ path, baseUrl: "http://127.0.0.1:8477/v1", apiKey: "old-key" });
	assert.equal(same.apiKeyMatches, true);

	// The comparison must not turn the diagnostic into a way to read the key.
	assert.ok(!JSON.stringify(stale).includes("old-key"), "no secret is echoed back");
	assert.ok(!JSON.stringify(stale).includes("new-key"));
});
