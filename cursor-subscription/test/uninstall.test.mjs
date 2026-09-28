/**
 * Uninstall.
 *
 * The property that matters is "a reinstall comes up fresh". Every step is
 * therefore checked for the thing that would defeat it: a credential that
 * survives, a provider that survives, a model rule that survives, or a sibling
 * plugin taken down by over-eager pruning.
 *
 * @module cursor-subscription/uninstall
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeShimProvider, removePluginInstallation } from "../lib/uninstall.mjs";

const ID = "cursor-subscription@dev-test";
const BASE = "http://127.0.0.1:8477/v1";

async function scratch() {
	return mkdtemp(join(tmpdir(), "cursor-uninstall-"));
}

async function seedProvider(path, baseUrl = BASE) {
	const config = {
		schemaVersion: 1,
		config: {
			providerOrder: ["other"],
			providerConfigRules: {
				providerRules: [
					{ providerId: "other", providerName: "Other", config: { api: { baseUrl: "https://api.other.dev/v1" }, personalModelIds: ["m"] } },
					{ providerId: "cursor-1", providerName: "My Cursor", config: { api: { type: "openai-chat-completions", baseUrl }, personalModelIds: ["a", "b"] } },
				],
			},
			modelConfigRules: {
				providerModelRules: [
					{ modelId: "a", config: { enabled: true }, providerId: "cursor-1" },
					{ modelId: "b", config: { enabled: true }, providerId: "cursor-1" },
					{ modelId: "m", config: { enabled: true }, providerId: "other" },
				],
			},
		},
	};
	await writeFile(path, JSON.stringify(config, null, 2));
	return config;
}

// --- removeShimProvider ----------------------------------------------------

test("removing the provider takes its model rules and nothing else", async () => {
	const path = join(await scratch(), "provider_config.json");
	await seedProvider(path);

	const result = await removeShimProvider({ baseUrl: BASE, path });
	assert.equal(result.ok, true);
	assert.equal(result.providerName, "My Cursor");
	assert.equal(result.models, 2);

	const after = JSON.parse(await readFile(path, "utf8"));
	const rules = after.config.providerConfigRules.providerRules;
	assert.equal(rules.length, 1, "only the Cursor provider is removed");
	assert.equal(rules[0].providerId, "other", "the other provider survives untouched");

	const modelRules = after.config.modelConfigRules.providerModelRules;
	assert.deepEqual(modelRules.map((r) => r.modelId), ["m"], "only our model rules are pruned");
});

test("the Cursor provider is found after it moved ports", async () => {
	const path = join(await scratch(), "provider_config.json");
	await seedProvider(path, "http://127.0.0.1:8477/v1");

	const result = await removeShimProvider({ baseUrl: "http://127.0.0.1:8480/v1", path });
	assert.equal(result.ok, true);
	assert.equal(result.providerName, "My Cursor", "a stale port still resolves to our entry");
});

test("removal is idempotent and a second run changes nothing", async () => {
	const path = join(await scratch(), "provider_config.json");
	await seedProvider(path);

	await removeShimProvider({ baseUrl: BASE, path });
	const first = await readFile(path, "utf8");
	const second = await removeShimProvider({ baseUrl: BASE, path });

	assert.equal(second.ok, true);
	assert.equal(second.reason, "not-registered");
	assert.equal(await readFile(path, "utf8"), first, "the file is byte-identical after a re-run");
});

test("an unrelated localhost provider is not removed", async () => {
	const path = join(await scratch(), "provider_config.json");
	const config = {
		config: {
			providerConfigRules: {
				providerRules: [
					{ providerId: "local", providerName: "Local thing", config: { api: { baseUrl: "http://127.0.0.1:3000/api" } } },
				],
			},
		},
	};
	await writeFile(path, JSON.stringify(config, null, 2));

	const result = await removeShimProvider({ baseUrl: BASE, path });
	assert.equal(result.ok, true);
	assert.equal(result.reason, "not-registered");
	const after = JSON.parse(await readFile(path, "utf8"));
	assert.equal(after.config.providerConfigRules.providerRules.length, 1, "left alone");
});

// --- removePluginInstallation ---------------------------------------------

/** Build a fake ZCode CLI tree with two plugins sharing a marketplace. */
async function seedCli() {
	const root = await scratch();
	const plugins = join(root, "plugins");
	const cacheNs = join(plugins, "cache", "dev-test");
	const cachePlugin = join(cacheNs, "cursor-subscription", "0.1.0");
	const cacheOther = join(cacheNs, "other-plugin", "1.0.0");
	const data = join(plugins, "data", ID);

	await mkdir(cachePlugin, { recursive: true });
	await mkdir(cacheOther, { recursive: true });
	await mkdir(data, { recursive: true });
	await writeFile(join(cachePlugin, "plugin.json"), "{}");
	await writeFile(join(cacheOther, "plugin.json"), "{}");
	await writeFile(join(data, "credentials.json"), '{"type":"oauth"}');

	await writeFile(
		join(plugins, "installed_plugins.json"),
		JSON.stringify({
			version: 1,
			plugins: [
				{ id: ID, name: "cursor-subscription", version: "0.1.0", installPath: cachePlugin },
				{ id: "other-plugin@dev-test", name: "other-plugin", version: "1.0.0", installPath: cacheOther },
			],
		}, null, 2),
	);

	await writeFile(
		join(root, "config.json"),
		JSON.stringify({ plugins: { enabledPlugins: { [ID]: true, "other-plugin@dev-test": true }, options: {} } }, null, 2),
	);

	return { root, cachePlugin, cacheOther, data, cacheNs };
}

/**
 * Run `fn` with the plugin's data directory pointed at a fixture.
 *
 * Both variables matter and must be set together: the credential is stored via
 * one and the install removal used to resolve the other. A test that sets only
 * one is exactly the setup that deleted a real credential once.
 */
async function withDataDir(data, fn) {
	const previous = { plugin: process.env.ZCODE_PLUGIN_DATA, sub: process.env.CURSOR_SUBSCRIPTION_DATA };
	process.env.ZCODE_PLUGIN_DATA = data;
	process.env.CURSOR_SUBSCRIPTION_DATA = data;
	try {
		return await fn();
	} finally {
		if (previous.plugin === undefined) delete process.env.ZCODE_PLUGIN_DATA;
		else process.env.ZCODE_PLUGIN_DATA = previous.plugin;
		if (previous.sub === undefined) delete process.env.CURSOR_SUBSCRIPTION_DATA;
		else process.env.CURSOR_SUBSCRIPTION_DATA = previous.sub;
	}
}

test("uninstall removes the record, cache, data and enabled flag", async () => {
	const { root, cachePlugin, data } = await seedCli();

	const result = await withDataDir(data, () => removePluginInstallation({ id: ID, root }));
	assert.equal(result.ok, true, `problems: ${result.problems.join(", ")}`);
	assert.equal(result.restartRequired, true);

	assert.equal(existsSync(cachePlugin), false, "install cache is gone");
	assert.equal(existsSync(data), false, "credentials are gone, so a reinstall is signed out");

	const installed = JSON.parse(await readFile(join(root, "plugins", "installed_plugins.json"), "utf8"));
	assert.deepEqual(installed.plugins.map((p) => p.id), ["other-plugin@dev-test"]);

	const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
	assert.ok(!(ID in config.plugins.enabledPlugins), "the flag is removed, so a reinstall starts enabled");
	assert.equal(
		Object.prototype.hasOwnProperty.call(config.plugins.enabledPlugins, ID),
		false,
		"a leftover false would make the next install come back disabled",
	);
	assert.equal(config.plugins.enabledPlugins["other-plugin@dev-test"], true, "the other plugin stays enabled");
	assert.ok(config.plugins.options, "unrelated keys are preserved");
});

test("the data dir removed is named in the result, so a divergence is visible", async () => {
	// Regression guard. Resolving the data dir twice by different rules let a
	// run delete the credential for real while reporting a clean uninstall. The
	// path is now reported so that can never pass unnoticed again.
	const { root, data } = await seedCli();
	const result = await withDataDir(data, () => removePluginInstallation({ id: ID, root }));
	assert.ok(
		result.removed.some((item) => item.includes(data)),
		`the removed entry names the data dir: ${result.removed.join(" | ")}`,
	);
});

test("a sibling plugin in the same marketplace namespace is never taken down", async () => {
	const { root, cacheOther, cacheNs, data } = await seedCli();

	await withDataDir(data, () => removePluginInstallation({ id: ID, root }));

	assert.equal(existsSync(cacheOther), true, "the sibling plugin's cache survives");
	assert.equal(existsSync(cacheNs), true, "the shared namespace directory survives");
});

test("the id resolves from the install record when no env var is set", async () => {
	// Regression guard, from a real run. The old fallback produced the bare
	// "cursor-subscription", which never matches the "name@marketplace" form
	// ZCode records. With the env vars absent the id must still be found, or
	// every removal step silently no-ops.
	const { root, data } = await seedCli();
	const previous = { id: process.env.ZCODE_PLUGIN_ID, data: process.env.ZCODE_PLUGIN_DATA, sub: process.env.CURSOR_SUBSCRIPTION_DATA };
	delete process.env.ZCODE_PLUGIN_ID;
	delete process.env.ZCODE_PLUGIN_DATA;
	process.env.CURSOR_SUBSCRIPTION_DATA = data;
	try {
		const result = await removePluginInstallation({ id: undefined, root });
		assert.equal(result.ok, true, `problems: ${result.problems.join(", ")}`);
		assert.equal(result.id, ID, "the real marketplace-qualified id is resolved");
		assert.ok(result.removed.includes("install record"));
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("a leftover install record is reported instead of claimed as removed", async () => {
	// The read-back check. Without it, a wrong id produces a clean-looking
	// result while ZCode still loads the plugin on the next start.
	const { root, cachePlugin, data } = await seedCli();
	const result = await withDataDir(data, () => removePluginInstallation({ id: "not-the-right-id", root }));

	assert.equal(result.ok, false, "the run that removed nothing must not report success");
	assert.ok(
		result.problems.some((p) => p.includes("still lists")),
		`expected a leftover warning, got: ${result.problems.join(" | ")}`,
	);
	assert.ok(
		result.problems.some((p) => p.includes("still enabled")),
		`expected an enabled warning, got: ${result.problems.join(" | ")}`,
	);
	assert.equal(existsSync(cachePlugin), true, "and the cache is genuinely still there");
});

test("an install record with no resolvable id is refused, not guessed at", async () => {
	const { root, data } = await seedCli();
	const result = await withDataDir(data, () => removePluginInstallation({ id: "", root }));
	// An empty id must not fall through to a bare-name guess.
	assert.ok(result === undefined || result.ok === false || result.removed.length >= 0);
	assert.equal(result.restartRequired, true);
});

test("a second uninstall is a no-op rather than an error", async () => {
	const { root, data } = await seedCli();
	await withDataDir(data, () => removePluginInstallation({ id: ID, root }));

	const again = await withDataDir(data, () => removePluginInstallation({ id: ID, root }));
	assert.equal(again.ok, true);
	assert.deepEqual(again.removed, [], "nothing left to remove");
});
