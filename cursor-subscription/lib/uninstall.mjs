/**
 * Undo everything this plugin added to this machine.
 *
 * Removing the plugin from the marketplace only removes the plugin. Everything
 * else it created outlives the code that made it, and a reinstall then inherits
 * all of it — which is the opposite of a fresh install:
 *
 *   1. the Cursor credential, a live bearer token in the data dir
 *   2. the provider entry, pointing at a port nothing serves
 *   3. the model rules, which keep those models listed as enabled
 *   4. the install record and cache, so ZCode still believes it is installed
 *   5. the enabled flag, so it loads again on next launch
 *
 * A provider left behind is the nasty one: it keeps showing up in the model
 * picker and fails on every use, long after anything named Cursor is gone.
 *
 * Two deliberate omissions. The **marketplace registration is kept** — it is
 * how a reinstall finds the plugin, and removing it would make this the one
 * irreversible step. And the running MCP server **cannot remove its own
 * executable**, so this process exits at the end rather than pretending the
 * last step is complete; a ZCode restart finishes the job.
 *
 * Every step is independently idempotent, so a half-finished cleanup is
 * re-runnable. Config writes preserve every other key and are atomic, on the
 * same terms as `register-provider.mjs`.
 *
 * @module cursor-subscription/uninstall
 */

import { readdir, readFile, rm, writeFile, rename, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

import { readConfig, writeConfig, findShimProvider, providerConfigPath } from "./register-provider.mjs";
import { dataDir } from "./config.mjs";

/**
 * The ZCode CLI directory, located by walking up from this plugin rather than
 * assumed.
 *
 * Deriving it from `ZCODE_PLUGIN_ROOT` by counting levels would be right today
 * and silently wrong the first time ZCode changes its cache layout, and a
 * wrong guess here means deleting the wrong directory. Looking for the file
 * that has to be there is self-correcting, and the fallback is only used when
 * the environment variable is absent.
 */
function cliDir() {
	const fromEnv = process.env.ZCODE_PLUGIN_ROOT;
	if (fromEnv) {
		let dir = dirname(fromEnv);
		// Bounded: the CLI dir is a handful of levels above the install path.
		for (let i = 0; i < 8; i += 1) {
			if (existsSync(join(dir, "plugins", "installed_plugins.json"))) return dir;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return join(homedir(), ".zcode", "cli");
}

/**
 * The plugin's id, e.g. `cursor-subscription@dev-zcode-cursor-b9b95b48`.
 *
 * Resolving this wrong is silent and total: nothing matches, every removal step
 * reports "nothing to do", and the uninstall claims success while leaving the
 * whole installation behind. So the id is confirmed against the install record
 * rather than assumed, and the bare name is never used as a last resort — it
 * lacks the `@marketplace` suffix and can never match anything.
 */
function pluginId(root = cliDir()) {
	if (process.env.ZCODE_PLUGIN_ID) return process.env.ZCODE_PLUGIN_ID;
	// ZCode sets this whenever it runs the plugin, and the directory it names
	// *is* the id.
	if (process.env.ZCODE_PLUGIN_DATA) return basename(process.env.ZCODE_PLUGIN_DATA);

	const installed = readInstalledSync(root);
	if (installed.length === 0) return undefined;
	const name = manifestName();

	// The install path is unambiguous when we are running from it.
	const fromRoot = process.env.ZCODE_PLUGIN_ROOT;
	if (fromRoot) {
		const match = installed.find((p) => p?.installPath && fromRoot.startsWith(p.installPath));
		if (match) return match.id;
	}
	// Otherwise the plugin's own name, provided exactly one entry carries it.
	const byName = installed.filter((p) => p?.name === name);
	return byName.length === 1 ? byName[0].id : undefined;
}

/** The `name` from this plugin's own manifest, in the source tree or the cache. */
function manifestName() {
	try {
		const manifest = new URL("../.zcode-plugin/plugin.json", import.meta.url);
		return JSON.parse(readFileSync(manifest, "utf8")).name;
	} catch {
		return undefined;
	}
}

function readInstalledSync(root) {
	try {
		const raw = readFileSync(join(root, "plugins", "installed_plugins.json"), "utf8");
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed?.plugins) ? parsed.plugins : [];
	} catch {
		return [];
	}
}

/** Write a JSON file atomically, creating its directory. */
async function writeJsonAtomic(path, value) {
	await mkdir(dirname(path), { recursive: true });
	const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
	await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await rename(tmp, path);
}

/**
 * Remove the shim provider and every model rule that belongs to it.
 *
 * Matching is by loopback host and path rather than by name, for the same
 * reason registration is: the user named the provider, not us. A shim that has
 * moved ports still matches, which matters here — the port it is leaving is
 * exactly the port that may be wrong in the entry.
 *
 * @param {object} input
 * @param {string} input.baseUrl the shim's current base URL.
 * @param {string} [input.path] config path override, for tests.
 * @returns {Promise<{ ok: boolean, reason?: string, advice?: string, providerName?: string, models?: number }>}
 */
export async function removeShimProvider({ baseUrl, path = providerConfigPath() }) {
	let config;
	try {
		config = await readConfig(path);
	} catch (error) {
		// No config means nothing of ours is registered, which is the goal state.
		if (error?.code === "ENOENT") return { ok: true, reason: "no-config", models: 0 };
		return {
			ok: false,
			reason: "config-unreadable",
			advice:
				`Could not read ZCode's provider config at ${path} (${error.message}). ` +
				"Remove the Cursor provider by hand in Settings → Model Provider.",
		};
	}

	const rules = config?.config?.providerConfigRules?.providerRules;
	if (!Array.isArray(rules)) {
		return {
			ok: false,
			reason: "config-shape-unknown",
			advice:
				"ZCode's provider config has an unexpected shape, so it was left untouched. " +
				"Remove the Cursor provider by hand in Settings → Model Provider.",
		};
	}

	const provider = findShimProvider(config, baseUrl);
	if (provider === undefined) {
		// Already gone. Not an error — this is what a re-run looks like.
		return { ok: true, reason: "not-registered", models: 0 };
	}

	const index = rules.findIndex((r) => r.providerId === provider.providerId);
	const removedName = rules[index]?.providerName ?? provider.providerName;
	rules.splice(index, 1);

	// Model rules are keyed by providerId and are not pruned by removing the
	// provider, so the removed models would stay listed as enabled forever.
	let models = 0;
	const perProvider = config.config.modelConfigRules?.providerModelRules;
	if (Array.isArray(perProvider)) {
		const kept = perProvider.filter((r) => r.providerId !== provider.providerId);
		models = perProvider.length - kept.length;
		perProvider.length = 0;
		perProvider.push(...kept);
	}

	try {
		await writeConfig(path, config);
	} catch (error) {
		return {
			ok: false,
			reason: "config-unwritable",
			advice:
				`Could not write ZCode's provider config (${error.message}). ` +
				"Remove the Cursor provider by hand in Settings → Model Provider.",
		};
	}

	return { ok: true, providerName: removedName, models };
}

/**
 * Remove the plugin's installation: its record, its cache and its data.
 *
 * The marketplace registration is deliberately left alone — it is how a
 * reinstall finds this plugin.
 *
 * Each target is reported separately so a partial failure is visible rather
 * than hidden behind an overall "done".
 *
 * @returns {Promise<{ ok: boolean, id: string, removed: string[], problems: string[], restartRequired: boolean }>}
 */
export async function removePluginInstallation({ id, root = cliDir() } = {}) {
	const removed = [];
	const problems = [];

	// Resolved here rather than as a default parameter, so it consults the same
	// `root` the removal uses. A default would have resolved the id against the
	// real ZCode tree while removing from somewhere else.
	const target = id ?? pluginId(root);
	if (!target) {
		// Guessing here is what produced a "successful" uninstall that removed
		// nothing. Say so instead of proceeding.
		return {
			ok: false,
			removed,
			problems: [
				"could not work out this plugin's id, so the install record, cache and enabled flag " +
					"were left alone. Remove the plugin from Plugin Marketplace instead.",
			],
			restartRequired: true,
		};
	}

	// 1. The install record — and its `installPath`, which has to be read before
	//    the record is rewritten, not after.
	const installedPath = join(root, "plugins", "installed_plugins.json");
	let installPath;
	try {
		const installed = JSON.parse(await readFile(installedPath, "utf8"));
		const list = Array.isArray(installed?.plugins) ? installed.plugins : [];
		const entry = list.find((p) => p?.id === target);
		installPath = entry?.installPath;
		const kept = list.filter((p) => p?.id !== target);
		if (kept.length !== list.length) {
			await writeJsonAtomic(installedPath, { ...installed, plugins: kept });
			removed.push("install record");
		}
	} catch (error) {
		if (error?.code !== "ENOENT") problems.push(`install record: ${error.message}`);
	}

	// 2. The install cache. Every version is removed, not just the one in the
	//    record: a version bump leaves the previous version's directory behind,
	//    and an uninstall that only clears the recorded path leaves stale code
	//    on disk that a later install can resurrect.
	try {
		const pluginDir = installPath ? dirname(installPath) : undefined;
		if (pluginDir && existsSync(pluginDir)) {
			const versions = await readdir(pluginDir);
			await rm(pluginDir, { recursive: true, force: true });
			removed.push(
				versions.length > 1
					? `install cache (${versions.length} versions: ${versions.sort().join(", ")})`
					: "install cache",
			);
			// Prune the namespace only when empty: other plugins may share it.
			const namespaceDir = dirname(pluginDir);
			if (existsSync(namespaceDir) && isEmptyDir(namespaceDir)) {
				await rm(namespaceDir, { recursive: true, force: true });
			}
		}
	} catch (error) {
		problems.push(`install cache: ${error.message}`);
	}

	// 3. The data dir — this is what makes a reinstall come up signed out.
	//    Resolved through `dataDir()` rather than read from the environment
	//    directly, so the directory deleted is provably the same one the
	//    credential was read from and written to. Two lookups that merely
	//    usually agree are how a cleanup ends up deleting the wrong tree.
	try {
		const dir = dataDir();
		if (existsSync(dir)) {
			await rm(dir, { recursive: true, force: true });
			removed.push(`credentials and local state (${dir})`);
		}
	} catch (error) {
		problems.push(`data dir: ${error.message}`);
	}

	// 4. The enabled flag. Removed, not set to false.
	//    Setting it false was defensive — stop a running ZCode loading a plugin
	//    whose files were mid-deletion — but it outlived the install that caused
	//    it: ZCode respects an existing `false`, so reinstalling the plugin
	//    brought it back *disabled* and the first install silently did nothing.
	//    ZCode reads this at startup, so deleting the key is equally safe and is
	//    what makes a fresh install actually start.
	try {
		const configPath = join(root, "config.json");
		const config = JSON.parse(await readFile(configPath, "utf8"));
		const enabled = config?.plugins?.enabledPlugins;
		if (enabled && target in enabled) {
			delete enabled[target];
			await writeJsonAtomic(configPath, config);
			removed.push("enabled flag");
		}
	} catch (error) {
		if (error?.code !== "ENOENT") problems.push(`config.json: ${error.message}`);
	}

	// 5. Verify rather than assume. Each step above treats "already gone" as
	//    success, which is right for a re-run and catastrophic if the id was
	//    wrong: every step would no-op and the uninstall would report a clean
	//    removal of an installation that is still fully in place.
	//
	//    The check looks for *any* surviving entry belonging to this plugin, not
	//    for the id that was tried. Comparing against the attempted id is what
	//    let the wrong-id case pass: the record still listed the real
	//    "name@marketplace" id, which simply was not the string searched for.
	const name = manifestName();
	const survivors = readInstalledSync(root).filter(
		(p) => p?.id === target || (name && (p?.name === name || String(p?.id ?? "").split("@")[0] === name)),
	);
	if (survivors.length > 0) {
		problems.push(
			`the install record still lists ${survivors.map((p) => p.id).join(", ")}. ZCode will load ` +
				"it again on the next start — remove it from Plugin Marketplace.",
		);
	}
	try {
		const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
		const stillEnabled = Object.entries(config?.plugins?.enabledPlugins ?? {})
			.filter(([key, value]) => value === true && (key === target || String(key).split("@")[0] === name))
			.map(([key]) => key);
		if (stillEnabled.length > 0) {
			problems.push(`${stillEnabled.join(", ")} is still enabled in config.json and will load on the next start.`);
		}
	} catch {
		// An unreadable config was already reported above if it mattered.
	}

	return {
		ok: problems.length === 0,
		id: target,
		removed,
		problems,
		// The MCP server cannot delete its own executable, and ZCode caches the
		// provider list, so a restart is the only thing that completes this.
		restartRequired: true,
	};
}

/** True when a directory has no entries. A vanished directory counts as empty. */
function isEmptyDir(dir) {
	try {
		return readdirSync(dir).length === 0;
	} catch {
		return true;
	}
}
