/**
 * Register the Cursor models into ZCode's provider configuration.
 *
 * ZCode cannot discover models from a custom provider — "Add model" in the
 * settings UI is a manual entry, and there is no plugin API for providers at
 * all. An account with 241 usable models therefore has no practical way to
 * populate the picker, which makes the whole integration unusable.
 *
 * So this writes the one field that matters, `personalModelIds`, into the
 * provider the user already created in Settings.
 *
 * The trade-off, stated plainly: this reads and rewrites ZCode's own config
 * file, an internal format rather than a public API. It is a deliberate
 * exception, not a preferred design — the alternative is a user clicking "Add
 * model" 241 times. Everything below is written to make the risk as small as
 * it can be: atomic write, preserve every other key, idempotent, and never
 * touch the credential.
 *
 * @module cursor-subscription/register-provider
 */

import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";


/**
 * The model configuration written for every Cursor model.
 *
 * Copied field-for-field from ZCode's own catch-all rule in
 * `config/provider/zcode-builtin.json`, because that config is *known to
 * validate*. ZCode silently drops any model whose resolved config fails
 * completeness validation — the model simply is not in the picker, with no
 * error at the call site — so building this by hand from the schema would be
 * trading a working default for a chance of a mystery.
 *
 * The deviations are the ones we can actually justify:
 *
 *   supportsImage        **false, and this was tested rather than assumed.**
 *                        The shim encodes images correctly — the payload and the
 *                        field-7 tag are both provably present in the run request,
 *                        matching the reference implementation byte for byte — but
 *                        two independent models both report receiving no image.
 *                        Cursor does not surface them on this endpoint. Claiming
 *                        support would make ZCode offer an attachment the model
 *                        never sees, which is worse than not offering it.
 *   supportsVideo        left false. Not verified, and a false claim is worse
 *                        than a missing one.
 *   supportsToolCall     true, and this is now proven live across four model
 *                        families: call, execute, and use the result.
 *   supportsJsonSchema   false. A `response_format` is folded into the system
 *                        prompt as an instruction, not enforced by the provider,
 *                        so claiming native schema support would overstate it.
 *   contextWindow        200k, matching the generic default. Cursor publishes no
 *                        per-model window, so a larger number would be invented.
 *   maxOutputTokens      unchanged from the baseline.
 */
function modelConfigFor() {
	return {
		enabled: true,
		properties: {
			contextWindow: 200_000,
			inputFormat: {
				supportsText: true,
				supportsImage: false,
				supportsVideo: false,
				supportsAudio: false,
				supportsPdf: false,
			},
			outputFormat: { supportsText: true },
			supportsToolCall: true,
			supportsJsonSchemaOutput: false,
			supportsNativeWebSearch: false,
			supportsMidConversationSystem: false,
			requiresMfjsToolSchema: false,
		},
		optionSpecs: {
			maxOutputTokens: { max: 32_000 },
		},
	};
}

/** The provider config ZCode reads for personal providers. */
export function providerConfigPath() {
	const base = process.env.ZCODE_DATA_BASE_DIR;
	const root = base
		? join(base, "v2")
		: process.env.ZCODE_V2_DIR ?? join(homedir(), ".zcode/v2");
	return join(root, "provider_config.json");
}

async function readConfig(path) {
	const raw = await readFile(path, "utf8");
	return JSON.parse(raw);
}

/** Write the config atomically so a crash cannot truncate ZCode's settings. */
async function writeConfig(path, config) {
	await mkdir(dirname(path), { recursive: true });
	const tmp = join(dirname(path), `.provider_config.${randomBytes(8).toString("hex")}.tmp`);
	await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	await rename(tmp, path);
}

export { readConfig, writeConfig };

/**
 * Find the provider that points at our shim.
 *
 * Matching on the loopback address rather than a name is deliberate: the user
 * names the provider whatever they like — "Cursor", "My Cursor", anything — and
 * a loopback base URL is the one thing we know.
 *
 * An exact match wins. Failing that, any loopback provider on the same path is
 * accepted even on a *different* port, because that is precisely the case where
 * the shim has moved and the entry needs bringing forward to where it actually
 * serves. Requiring the port to match would leave a moved shim unable to repair
 * the one entry that describes it.
 *
 * @returns {{ providerId: string, providerName: string, baseUrl: string } | undefined}
 */
export function findShimProvider(config, shimBaseUrl) {
	const rules = config?.config?.providerConfigRules?.providerRules ?? [];
	const normalise = (value) => String(value ?? "").replace(/\/+$/, "");
	const target = normalise(shimBaseUrl);
	if (!target) return undefined;
	const wanted = new URL(target);

	const describe = (rule, base) => ({
		providerId: rule.providerId,
		providerName: rule.providerName,
		baseUrl: base,
	});

	// Pass 1: the URL matches exactly, so there is nothing to reconcile.
	for (const rule of rules) {
		const base = normalise(rule?.config?.api?.baseUrl);
		if (base && base === target) return describe(rule, base);
	}

	// Pass 2: a shim that has moved. Only a loopback entry can be ours, so an
	// unrelated provider is never rewritten.
	for (const rule of rules) {
		const base = normalise(rule?.config?.api?.baseUrl);
		if (!base) continue;
		let candidate;
		try {
			candidate = new URL(base);
		} catch {
			continue;
		}
		const loopback = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(candidate.hostname);
		if (!loopback) continue;
		if (candidate.hostname !== wanted.hostname) continue;
		if (candidate.pathname.replace(/\/+$/, "") !== wanted.pathname.replace(/\/+$/, "")) continue;
		return describe(rule, base);
	}

	return undefined;
}

/**
 * Write `personalModelIds` for the shim provider.
 *
 * @param {object} input
 * @param {string[]} input.models model ids to publish.
 * @param {string} input.baseUrl the shim base URL, used to find the provider.
 * @param {string} [input.path] config path override, for tests.
 * @param {string} [input.providerName] optional rename, per the user's request.
 * @returns {Promise<{ ok: boolean, reason?: string, advice?: string, providerId?: string, added?: number, total?: number }>}
 */
/**
 * Create the provider entry if it does not exist, then register the models.
 *
 * Creating the provider used to be a step the user performed by hand in the
 * Settings UI, and that made onboarding depend on them knowing what a
 * "custom provider" is and which of six fields to fill. ZCode has no plugin API
 * for providers — but it does read a plain JSON file, and this module already
 * writes that file atomically, preserves every other key, and matches by base
 * URL rather than by name. So the same careful write that populates the model
 * list can create the entry too.
 *
 * The trade-off is stated plainly: this puts an entry into the user's model
 * picker that they did not add by hand. It is the same class of write as
 * `registerModels`, against the same schema, and the user can delete it in
 * Settings at any time.
 *
 * @param {object} input
 * @param {string[]} input.models model ids to publish.
 * @param {string} input.baseUrl the shim base URL.
 * @param {string} input.apiKey the shim's loopback API key.
 * @param {string} [input.path] config path override, for tests.
 * @param {string} [input.providerName] display name; defaults to Cursor Subscription.
 * @param {string} [input.apiType] ZCode's closed enum value for the API shape.
 */
export async function ensureShimProvider({
	models,
	baseUrl,
	apiKey,
	path = providerConfigPath(),
	providerName = "Cursor Subscription",
	apiType = "openai-chat-completions",
}) {
	let config;
	try {
		config = await readConfig(path);
	} catch (error) {
		if (error?.code !== "ENOENT") {
			return {
				ok: false,
				reason: "config-unreadable",
				advice: `Could not read ZCode's provider config at ${path} (${error.message}).`,
			};
		}
		// A missing config is not a missing plugin: ZCode writes it on first run.
		// Creating it here would risk clobbering that first run, so say so.
		return {
			ok: false,
			reason: "config-missing",
			advice:
				`ZCode's provider config at ${path} does not exist yet. Open ZCode's Settings once ` +
				"so it writes its defaults, then run this again.",
		};
	}

	const rules = config?.config?.providerConfigRules;
	if (!Array.isArray(rules?.providerRules)) {
		return {
			ok: false,
			reason: "config-shape-unknown",
			advice:
				"ZCode's provider config has an unexpected shape, so it was left untouched. " +
				"Add the provider by hand in Settings → Model Provider.",
		};
	}

	let created = false;
	const existing = findShimProvider(config, baseUrl);
	if (existing === undefined) {
		const providerId = `cursor-${randomBytes(4).toString("hex")}`;
		rules.providerRules.push({
			providerId,
			providerName,
			config: {
				group: "standard-personal",
				access: { type: "api-key", apiKey },
				api: { type: apiType, baseUrl },
				personalModelIds: [],
			},
		});
		created = true;
	}

	// Refresh the key on an entry that already exists. Reinstalling the plugin
	// wipes the data directory, so the next launch mints a *new* shim key while
	// the provider keeps the old one — and every request then fails 401. Since
	// re-running the setup is the natural recovery, it has to be a repair rather
	// than a no-op. Matched by base URL, so a renamed provider is still found.
	if (!created && existing !== undefined) {
		const rule = rules.providerRules.find((r) => r.providerId === existing.providerId);
		if (rule?.config?.access?.apiKey !== apiKey) {
			rule.config = rule.config ?? {};
			rule.config.access = { ...(rule.config.access ?? {}), type: "api-key", apiKey };
			try {
				await writeConfig(path, config);
			} catch (error) {
				return {
					ok: false,
					reason: "config-unwritable",
					advice: `Could not update the provider's API key (${error.message}).`,
				};
			}
		}
	}

	// Persist the new entry before delegating. `registerModels` re-reads the file
	// from disk, so an in-memory push alone would leave it looking for a provider
	// that does not exist yet and failing with "create one first" — the exact
	// manual step this function exists to remove.
	if (created) {
		try {
			await writeConfig(path, config);
		} catch (error) {
			return {
				ok: false,
				reason: "config-unwritable",
				advice: `Could not write ZCode's provider config (${error.message}).`,
			};
		}
	}

	const result = await registerModels({ models, baseUrl, path, providerName: created ? providerName : undefined });
	if (!result.ok) return result;
	return { ...result, created, apiType };
}

export async function registerModels({ models, baseUrl, path = providerConfigPath(), providerName }) {
	const clean = [...new Set(models.filter((m) => typeof m === "string" && m.length > 0))].sort();
	if (clean.length === 0) {
		return {
			ok: false,
			reason: "no-models",
			advice: "Cursor reported no usable models, so there is nothing to register.",
		};
	}

	let config;
	try {
		config = await readConfig(path);
	} catch (error) {
		return {
			ok: false,
			reason: "config-unreadable",
			advice:
				`Could not read ZCode's provider config at ${path} (${error.message}). ` +
				"Add the models by hand with the + Add model button instead.",
		};
	}

	const rules = config?.config?.providerConfigRules?.providerRules;
	if (!Array.isArray(rules)) {
		return {
			ok: false,
			reason: "config-shape-unknown",
			advice:
				"ZCode's provider config has an unexpected shape, so it was left untouched. " +
				"Add the models by hand with the + Add model button.",
		};
	}

	const provider = findShimProvider(config, baseUrl);
	if (provider === undefined) {
		return {
			ok: false,
			reason: "provider-not-found",
			advice:
				`No ZCode provider points at ${baseUrl}. Create one first: ` +
				"Settings → Model Provider → Add → Create Custom Provider, with API format " +
				"`Chat completions (/chat/completions)` and that base URL, then run this again.",
		};
	}

	const rule = rules.find((r) => r.providerId === provider.providerId);
	const before = Array.isArray(rule.config?.personalModelIds) ? rule.config.personalModelIds.length : 0;
	rule.config = rule.config ?? {};

	// Keep the provider aimed at the port the shim actually bound. A shim that
	// had to move leaves a provider pointing at a port nothing answers on, and
	// that reads as a broken provider rather than a stale URL.
	let baseUrlUpdated = false;
	const wanted = baseUrl.replace(/\/+$/, "");
	if (rule.config.api?.baseUrl && rule.config.api.baseUrl.replace(/\/+$/, "") !== wanted) {
		rule.config.api = { ...rule.config.api, baseUrl: wanted };
		baseUrlUpdated = true;
	}

	rule.config.personalModelIds = clean;
	if (providerName) rule.providerName = providerName;

	// Mirror each model into modelConfigRules as enabled, the way ZCode records a
	// model that is switched on. Without this a model listed in personalModelIds
	// can still be filtered out at selection time.
	const modelRules = (config.config.modelConfigRules ??= {});
	const perProvider = (modelRules.providerModelRules ??= []);
	for (const modelId of clean) {
		const existingRule = perProvider.find(
			(r) => r.providerId === provider.providerId && r.modelId === modelId,
		);
		const config = modelConfigFor();
		if (existingRule) {
			// Refresh rather than skip: an entry written by an earlier version held
			// only `{ enabled: true }` and inherited generic capabilities the model
			// does not deserve credit for — or, worse, understated what it can do.
			existingRule.config = config;
		} else {
			perProvider.push({ modelId, config, providerId: provider.providerId });
		}
	}

	try {
		await writeConfig(path, config);
	} catch (error) {
		return {
			ok: false,
			reason: "config-unwritable",
			advice:
				`Could not write ZCode's provider config (${error.message}). ` +
				"Add the models by hand with the + Add model button instead.",
		};
	}

	return {
		ok: true,
		providerId: provider.providerId,
		providerName: rule.providerName,
		baseUrl,
		baseUrlUpdated,
		added: clean.length - before,
		total: clean.length,
	};
}

/**
 * Repair a provider entry that points at us but holds a stale API key.
 *
 * Uninstall removes the data directory, so the next launch mints a *new* shim
 * key. ZCode holds `provider_config.json` in memory and writes its own copy
 * back, which can resurrect the provider entry we removed — leaving an entry
 * that is correctly addressed and permanently 401. That combination is what
 * produced "invalid api key" in the UI with no way to tell why.
 *
 * So the shim reconciles on start. It only ever *repairs* an entry that is
 * already ours; it never creates one, never touches the model list, and never
 * runs if there is nothing to fix. Making the user discover this by reading a
 * 401 is the failure mode being designed out.
 *
 * @returns {Promise<{ checked: boolean, repaired: boolean, providerName?: string }>}
 */
export async function reconcileProviderKey({ baseUrl, apiKey, path = providerConfigPath() }) {
	let config;
	try {
		config = await readConfig(path);
	} catch {
		return { checked: false, repaired: false };
	}
	const match = findShimProvider(config, baseUrl);
	if (match === undefined) return { checked: true, repaired: false };

	const rules = config.config?.providerConfigRules?.providerRules ?? [];
	const rule = rules.find((r) => r.providerId === match.providerId);
	if (!rule || rule.config?.access?.apiKey === apiKey) {
		return { checked: true, repaired: false, providerName: match.providerName };
	}

	rule.config = rule.config ?? {};
	rule.config.access = { ...(rule.config.access ?? {}), type: "api-key", apiKey };
	try {
		await writeConfig(path, config);
	} catch {
		return { checked: true, repaired: false, providerName: match.providerName };
	}
	return { checked: true, repaired: true, providerName: match.providerName };
}
