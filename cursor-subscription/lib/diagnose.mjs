/**
 * One-shot diagnosis of the whole integration.
 *
 * The pieces of state this needs live in three unrelated places — the
 * credential store, the running shim, and ZCode's provider config — so the
 * failures that actually happen are the *disagreements* between them. A shim
 * that moved ports while the provider still points at the old one is
 * individually healthy and completely broken, and nothing that reports only its
 * own state can see it.
 *
 * Read-only. Diagnosing must never be the thing that changes state, so a user
 * can run it freely while something is broken and get a true picture.
 *
 * @module cursor-subscription/diagnose
 */

import { readFile } from "node:fs/promises";

import { findShimProvider, providerConfigPath } from "./register-provider.mjs";

/**
 * What ZCode's provider config says about the Cursor provider.
 *
 * Never writes. A provider that is absent is reported, not created — setup is
 * `cursor_register_models`' job, and a diagnostic that quietly fixes things
 * reports a healthy system it did not find.
 *
 * @returns {Promise<{ found: boolean, path: string, error?: string, providerName?: string, baseUrl?: string, models?: number, modelRules?: number }>}
 */
export async function inspectProviderConfig({ path = providerConfigPath(), baseUrl } = {}) {
	let config;
	try {
		config = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		return { found: false, path, error: `could not read it (${error.message})` };
	}

	const rules = config?.config?.providerConfigRules?.providerRules;
	if (!Array.isArray(rules)) {
		return { found: false, path, error: "it has an unexpected shape" };
	}

	// Match on the host, not on the port: a shim that has moved is still ours,
	// and matching the exact URL would report a moved shim as simply absent.
	const match = baseUrl ? findShimProvider(config, baseUrl) : undefined;
	if (!match) {
		return { found: false, path };
	}

	const modelRules = config?.config?.modelConfigRules?.providerModelRules ?? [];
	return {
		found: true,
		path,
		providerName: match.providerName,
		baseUrl: match.baseUrl,
		models: rules.find((r) => r.providerId === match.providerId)?.config?.personalModelIds?.length ?? 0,
		modelRules: modelRules.filter((r) => r.providerId === match.providerId).length,
	};
}

/**
 * Compare what the shim is actually serving against what ZCode is configured
 * to call, and explain the gap in a sentence.
 *
 * @returns {{ ok: boolean, detail: string }}
 */
export function compareEndpoints(actualBaseUrl, configuredBaseUrl) {
	if (!configuredBaseUrl) {
		return { ok: false, detail: "no Cursor provider exists in ZCode's settings" };
	}
	const normalise = (value) => String(value ?? "").replace(/\/+$/, "");
	if (normalise(actualBaseUrl) === normalise(configuredBaseUrl)) {
		return { ok: true, detail: `ZCode's provider points at ${configuredBaseUrl}` };
	}
	return {
		ok: false,
		detail:
			`ZCode's provider points at ${configuredBaseUrl} but the shim is serving ${actualBaseUrl}. ` +
			"Every request will fail until the provider's base URL matches — run cursor_register_models " +
			"to bring it back in step.",
	};
}
