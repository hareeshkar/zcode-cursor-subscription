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
import { createHash, timingSafeEqual } from "node:crypto";

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
export async function inspectProviderConfig({ path = providerConfigPath(), baseUrl, apiKey } = {}) {
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
	const rule = rules.find((r) => r.providerId === match.providerId);
	return {
		found: true,
		path,
		providerName: match.providerName,
		baseUrl: match.baseUrl,
		models: rule?.config?.personalModelIds?.length ?? 0,
		modelRules: modelRules.filter((r) => r.providerId === match.providerId).length,
		apiKeyMatches: apiKey === undefined ? undefined : sameSecret(rule?.config?.access?.apiKey, apiKey),
	};
}

/**
 * Compare two secrets without revealing either.
 *
 * The mismatch that breaks a provider is a stale key after a reinstall, and it
 * is invisible from the outside: a 401 is the only symptom, and the reason is
 * not obvious. Hashing lets `cursor_doctor` name the fault as a mismatch
 * rather than leaving the user to guess — without the diagnostic ever becoming
 * a way to read the key.
 */
function sameSecret(a, b) {
	if (typeof a !== "string" || typeof b !== "string") return false;
	const digest = (value) => createHash("sha256").update(value).digest();
	try {
		return timingSafeEqual(digest(a), digest(b));
	} catch {
		return false;
	}
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
