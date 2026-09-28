#!/usr/bin/env node
/**
 * MCP management surface.
 *
 * These tools *manage* the Cursor connection — sign-in, status, sign-out, model
 * list — and report the shim's health. Chat never routes through MCP: the
 * Cursor model is a first-class ZCode provider reached over the shim's
 * OpenAI-compatible endpoint, so ZCode's own context, tool and permission
 * machinery applies to it unchanged.
 *
 * @module cursor-subscription/mcp-server
 */

import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CursorAuthService } from "../lib/auth.mjs";
import { CredentialStore } from "../lib/credentials.mjs";
import { CursorShim } from "../lib/shim.mjs";
import { fetchUsableModels, modelIds, sortModelsByName } from "../lib/cursor-client.mjs";
import { pickProbeModels, probeModel } from "../lib/selftest.mjs";
import { registerModels, ensureShimProvider, reconcileProviderKey } from "../lib/register-provider.mjs";
import { removeShimProvider, removePluginInstallation } from "../lib/uninstall.mjs";
import { compareEndpoints, inspectProviderConfig } from "../lib/diagnose.mjs";
import { DEFAULT_SHIM_PORT, FALLBACK_MODELS, SHIM_HOST, SHIM_PATHS, dataDir } from "../lib/config.mjs";

const PROTOCOL_VERSION = "2025-06-18";

/**
 * Shown before sign-in.
 *
 * This is not boilerplate. Relaying a consumer subscription through a
 * third-party client is the activity most likely to trip Cursor's account
 * protections, so the user is told plainly before any browser opens rather than
 * discovering it in a README.
 */
const CONSENT_NOTICE = [
	"This signs in to your Cursor account and uses your Cursor subscription to run ZCode sessions.",
	"",
	"Cursor's agent protocol is not public. Relaying a consumer subscription through a",
	"third-party client is exactly the activity most likely to trip Cursor's account",
	"protections. Use this for your own local work, expect it to break when Cursor",
	"changes its servers, and do not redistribute it or use it to serve other people.",
].join("\n");

const store = new CredentialStore();
const auth = new CursorAuthService(store);

/**
 * The shim's local API key.
 *
 * ZCode requires a non-blank key on a provider entry, so the shim must have one
 * too — an empty key makes it reject every request with a 401, which looks
 * exactly like "the provider is broken". Reuse an explicit key, otherwise reuse
 * the one already written beside the credentials, otherwise mint one and print
 * it with the URL the user should paste into ZCode.
 */
function resolveShimKey() {
	if (process.env.CURSOR_SHIM_KEY) return process.env.CURSOR_SHIM_KEY;
	try {
		const existing = readFileSync(join(dataDir(), "shim-key"), "utf8").trim();
		if (existing) return existing;
	} catch {
		// First run.
	}
	const generated = randomBytes(24).toString("base64url");
	try {
		mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
		writeFileSync(join(dataDir(), "shim-key"), `${generated}\n`, { mode: 0o600 });
	} catch {
		// Non-fatal: the key still works for this process.
	}
	process.stderr.write(
		`cursor-subscription: shim listening on http://${SHIM_HOST}:${DEFAULT_SHIM_PORT}/v1\n` +
			`cursor-subscription: add a ZCode provider with\n` +
			`    base URL : http://${SHIM_HOST}:${DEFAULT_SHIM_PORT}/v1\n` +
			`    API type : openai-chat-completions\n` +
			`    API key  : ${generated}\n`,
	);
	return generated;
}

const shim = new CursorShim({ store, auth, apiKey: resolveShimKey() });

/**
 * The shim's origin, on the port actually bound.
 *
 * It must come from `shim.port` rather than the configured port: a clash moves
 * the shim, and a URL pointing at the old port is exactly the failure this
 * integration is supposed to remove. Every caller awaits `shim.bound` first so
 * it can never read a stale port.
 */
async function shimOrigin() {
	const outcome = await shim.bound;
	if (!outcome.ok) {
		throw Object.assign(
			new Error(outcome.error?.message ?? "the shim could not bind a port"),
			{
				advice:
					`The shim could not bind a port on ${shim.host} (tried ${shim.preferredPort} onwards). ` +
					"Close whatever is holding those ports, or set a different port in the plugin settings, " +
					"then try again.",
			},
		);
	}
	return `http://${shim.host}:${shim.port}`;
}

/**
 * The base URL to hand the user and to register models against.
 *
 * Distinct from the origin on purpose: `probeModel` builds its own path from
 * the origin, and ZCode's provider entry wants the `/v1` suffix. Passing the
 * origin where a base URL belongs is what produces a `/v1/v1/...` 404.
 */
async function shimBaseUrl() {
	return `${await shimOrigin()}/v1`;
}

/** A one-line note when the shim is not the port's owner, for the user to see. */
function portNotice() {
	if (shim.movedPort) {
		return (
			`Note: port ${shim.preferredPort} was already taken, so the shim is on ` +
			`${shim.host}:${shim.port}. The base URL below is the one that works — ` +
			"use it, and the provider entry will be kept in step with it.\n"
		);
	}
	return "";
}

const content = (text, isError = false) => ({ content: [{ type: "text", text }], isError });

const TOOLS = [
	{
		name: "cursor_import",
		description:
			"Connect to an EXISTING Cursor account on this machine by adopting the session " +
			"Cursor already stored locally. This is the correct first step whenever the user " +
			"already uses Cursor — it is instant, needs no browser, and never re-authenticates. " +
			"Only fall back to cursor_login if this reports that no local session was found.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		run: async () => {
			const status = await auth.importLocal();
			return content(
				`Imported the Cursor session from the local install` +
					`${status.account ? ` (${status.account})` : ""}. ` +
					"Cursor models are now available in the ZCode model picker.",
			);
		},
	},
	{
		name: "cursor_login",
		description:
			"Sign in to Cursor by opening a browser. ONLY use this when the user has no Cursor " +
			"account on this machine, or when cursor_import has failed. If the user already has " +
			"Cursor installed and signed in, use cursor_import instead — it is instant and needs " +
			"no browser. Run this once; the token then refreshes automatically.",
		// `confirmed` must be declared: the gate already reads it, and a schema that
		// forbids it tells the model the argument is illegal.
		inputSchema: {
			type: "object",
			properties: {
				confirmed: {
					type: "boolean",
					description: "Set true once the user has agreed to sign in. Omit it first to see the notice.",
				},
			},
		},
		explain: async () =>
			content(
				`${CONSENT_NOTICE}\n\nSign in now? Re-run with confirmed: true to open the browser.`,
			),
		run: async () => {
			const status = await auth.status();
			if (status.authenticated) {
				return content(
					`Already signed in${status.account ? ` as ${status.account}` : ""}. ` +
						"Use cursor_status for details.",
				);
			}
			const result = await auth.login({
				// Hand the URL back at once so a caller can show it while the browser
				// flow is still in progress, rather than after a silent wait.
				onUrl: (url) => process.stderr.write(`cursor-subscription: sign in at ${url}\n`),
			});
			return content(
				`Signed in${result.account ? ` as ${result.account}` : ""}. ` +
					"Cursor models are now available in the ZCode model picker.",
			);
		},
	},
	{
		name: "cursor_selftest",
		description:
			"End-to-end verification: confirm the local Cursor session works by sending a tiny real " +
			"completion through the shim on several models. Picks cheap models automatically and " +
			"skips expensive families, because each probe is a real billable request. Use this to " +
			"prove setup is finished before the user configures anything in Settings.",
		inputSchema: {
			type: "object",
			properties: {
				models: {
					type: "number",
					description: "How many models to probe. Default 6, max 10.",
				},
			},
		},
		run: async (args = {}) => {
			const status = await auth.status();
			if (!status.authenticated) {
				return content("Not connected. Run cursor_import first.", true);
			}
			const baseUrl = await shimBaseUrl();
			const origin = await shimOrigin();
			const token = await auth.accessToken();
			const available = sortModelsByName(await fetchUsableModels(token));
			const limit = Math.min(Math.max(Number(args.models) || 6, 1), 10);
			const picked = pickProbeModels(available, { limit });

			const results = [];
			for (const model of picked) {
				results.push(await probeModel(origin, shim.apiKey, model));
			}

			const passed = results.filter((r) => r.ok);
			const lines = [
				`Probed ${results.length} of ${available.length} available models ` +
					`(cheap tiers only, to keep this off your quota):`,
				"",
				...results.map(
					(r) => `  ${r.ok ? "PASS" : "FAIL"}  ${r.model.padEnd(26)} ${String(r.ms).padStart(6)}ms  ${r.detail}`,
				),
				"",
				`${passed.length}/${results.length} models answered.`,
			];
			if (passed.length === 0) {
				lines.push(
					"",
					"Nothing worked. Re-run cursor_import to refresh the session, and if it still " +
						"fails report it — do not ask the user to change Settings yet.",
				);
			} else {
				lines.push(
					"",
					portNotice() + "Working models to add in Settings → Model Provider → Add:",
					"  API type : openai-chat-completions",
					`  Base URL : ${baseUrl}`,
					`  API key  : ${shim.apiKey}`,
					"",
					"Add a few of the models that passed to the provider's model list, then pick one " +
						"in the model picker.",
				);
			}
			return content(lines.join("\n"));
		},
	},
	{
		name: "cursor_register_models",
		description:
			"Fill the Cursor provider's model list in ZCode so its models appear in the model picker. " +
			"ZCode cannot discover models from a custom provider and its settings UI only adds one at " +
			"a time, so this writes the discovered model ids into ZCode's provider config. " +
			"Run this AFTER the user has created the provider in Settings, and tell them to reload " +
			"ZCode afterwards for the list to appear.",
		inputSchema: {
			type: "object",
			properties: {
				models: {
					type: "number",
					description:
						"How many models to publish. Defaults to the models that passed the self-test. " +
						"Use a smaller number if the user wants a short list.",
				},
				rename: {
					type: "string",
					description: "Optional new display name for the provider, e.g. 'My Cursor'.",
				},
			},
		},
		run: async (args = {}) => {
			const status = await auth.status();
			if (!status.authenticated) {
				return content("Not connected. Run cursor_import first.", true);
			}
			const baseUrl = await shimBaseUrl();
			const token = await auth.accessToken();
			const available = sortModelsByName(await fetchUsableModels(token));
			const limit = Number(args.models);
			const models =
				Number.isFinite(limit) && limit > 0
					? // A cap is expressed as ids; map back to the capability objects.
						pickProbeModels(modelIds(available), { limit }).map(
							(id) => available.find((m) => m.name === id) ?? id,
						)
					: available;

			const result = await registerModels({
				models,
				baseUrl,
				...(args.rename ? { providerName: args.rename } : {}),
			});
			if (!result.ok) return content(`${result.advice}\n\n(reason: ${result.reason})`, true);
			return content(
				`Registered ${result.total} models on provider "${result.providerName}" ` +
					`(${result.added} newly added, base URL ${baseUrl}` +
					`${result.baseUrlUpdated ? ", updated to follow the shim's port" : ""}).\n\n` +
					"Tell the user to reload ZCode — the model picker reads the provider config at " +
					"startup, so the list will not appear until then. The models are then selectable " +
					"from the model picker like any other.",
			);
		},
	},
	{
		name: "cursor_connect_and_initialize",
		description:
			"Connect and initialise Cursor as a ZCode model provider, end to end, in one call: adopt the " +
			"local Cursor session, prove it can answer with a real completion, create the provider entry " +
			"in ZCode's config, and publish the full model list. This is the entire setup — nothing is " +
			"left for the user to paste into Settings. Use this instead of calling cursor_import, " +
			"cursor_selftest and cursor_register_models separately, which is how steps get skipped.",
		inputSchema: {
			type: "object",
			properties: {
				models: {
					type: "number",
					description:
						"Optional cap on how many models to publish. Omit to publish every model the " +
						"account can use, which is the default and what most people want — the picker " +
						"searches. This never limits the self-test, which always probes cheap models only.",
				},
			},
		},
		run: async (args = {}) => {
			const steps = [];
			let healthy = true;

			// 1. A live Cursor session. Adopt the local install first: instant, and
			//    no browser for the overwhelmingly common case.
			let status = await auth.status();
			if (!status.authenticated) {
				try {
					await auth.importLocal();
					status = await auth.status();
				} catch {
					// Fall through to the report below, which tells the user to
					// run cursor_login — the only path that needs a browser.
				}
			}
			if (status.authenticated) {
				steps.push(
					`Cursor session ready${status.account ? ` (${status.account})` : ""}` +
						`${status.expiresAt ? `, valid to ${new Date(status.expiresAt).toISOString().slice(0, 10)}` : ""}`,
				);
			} else {
				healthy = false;
				steps.push(
					"NOT CONNECTED: no Cursor session. Ask the user to run cursor_login, or open Cursor " +
						"and sign in, then run this again.",
				);
				return content(["Setup stopped — the Cursor session is the first thing that has to work.", "", ...steps.map((s) => `  - ${s}`)].join("\n"), true);
			}

			// 2. Prove it can answer, before writing any config that points at it.
			const serving = await shim.servingState();
			if (!serving.ok) {
				healthy = false;
				steps.push(`Shim not serving (${serving.reason}). A restart of ZCode clears this.`);
				return content(["Setup stopped — nothing is listening yet.", "", ...steps.map((s) => `  - ${s}`)].join("\n"), true);
			}

			const available = sortModelsByName(await fetchUsableModels(await auth.accessToken()));
			// Two different jobs, and conflating them was the bug: a probe is a real
			// billable request, so it stays on cheap models to protect the user's
			// quota — but the probe is a transport check, not a catalogue. The user
			// pays for these models either way, and the picker is the only place
			// they can see what their subscription actually includes. So publish
			// everything the account reports, not just what was cheap enough to test.
			const probeSet = pickProbeModels(modelIds(available), { limit: 6 });
			const probes = [];
			for (const model of probeSet) {
				probes.push(await probeModel(await shimOrigin(), shim.apiKey, model));
			}
			const passed = probes.filter((p) => p.ok);
			if (passed.length === 0) {
				healthy = false;
				steps.push("Self-test: 0 models answered. Nothing was written to ZCode.");
				return content(
					[
						"Setup stopped — the Cursor session cannot answer, so no provider was created.",
						"",
						...steps.map((s) => `  - ${s}`),
						`  - probes: ${probes.map((p) => `${p.model} ${p.detail}`).join("; ") || "none"}`,
						"",
						"Do not point ZCode at this. Re-run cursor_import, and if it still fails, report it.",
					].join("\n"),
					true,
				);
			}
			steps.push(`Self-test: ${passed.length}/${probes.length} models answered`);

			// 3. Create the provider if it is missing, and publish every model the
			//    account can use. The user is not asked to open Settings at any point.
			const cap = Number(args.models);
			// Objects, not ids: registration reads each model's capabilities from
			// Cursor's own declaration rather than writing one blanket guess.
			const modelsToPublish =
				Number.isFinite(cap) && cap > 0 ? available.slice(0, cap) : available;
			const publishIds = modelIds(modelsToPublish);
			const registered = await ensureShimProvider({
				models: modelsToPublish,
				baseUrl: await shimBaseUrl(),
				apiKey: shim.apiKey,
			});
			if (!registered.ok) {
				healthy = false;
				steps.push(`Provider NOT written (${registered.reason}). ${registered.advice ?? ""}`);
				return content(["Setup stopped before ZCode was changed.", "", ...steps.map((s) => `  - ${s}`)].join("\n"), true);
			}
			steps.push(
				`Provider ${registered.created ? "created" : "already present"} as "${registered.providerName}" ` +
					`with ${registered.total} of ${available.length} available models` +
					`${registered.baseUrlUpdated ? " (base URL updated to the shim's port)" : ""}`,
			);

			// Suggest a model that was actually probed, and is a cheap one. The
			// published list is alphabetical, so its first entry is whatever model
			// happens to sort first — which would walk a new user straight onto a
			// premium model and spend their credits on the first message.
			const suggested = passed[0]?.model ?? modelsToPublish[0];
			// by hand. On the success path everything above is already written to
			// ZCode's config, so a copy-paste block is noise — and echoing a
			// credential the user has no use for is a small risk for no gain.
			// Only ever shown when the run could not finish, and then it is the
			// user's way out. Printing it on success is noise: everything is already
			// written, and a credential echoed for no reason is a small risk.
			const block = [
				"",
				"If you have to finish this by hand, these are the values — Settings → Model Provider →",
				"Add → Create Custom Provider:",
				`  API type     : ${registered.apiType}`,
				`  Base URL     : ${await shimBaseUrl()}`,
				`  API key      : ${shim.apiKey}`,
				`  Request path : POST ${SHIM_PATHS.chat}`,
				`  Models path  : GET ${SHIM_PATHS.models}`,
				`  Response API : Chat completions (${SHIM_PATHS.chat})`,
				`  Model        : ${suggested}  (+${Math.max(publishIds.length - 1, 0)} more)`,
			];

			return content(
				[
					"Connected. Cursor is now a ZCode model provider.",
					"",
					"What just happened:",
					...steps.map((s) => `  • ${s}`),
					"",
					"Next:",
					`  1. Quit ZCode completely (⌘Q, not just closing the window) and reopen it. This is`,
					"     the only step left — the model picker reads the configuration when ZCode starts,",
					"     so the models will not appear until you do.",
					`  2. Click the model picker and choose "${suggested}" from the "Cursor Subscription"`,
					"     provider.",
					"",
					"Nothing needs to be pasted into Settings — the provider is already written.",
					...(healthy ? [] : block),
				].join("\n"),
				!healthy,
			);
		},
	},
	{
		name: "cursor_doctor",
		description:
			"Check the whole integration at once and report what disagrees: is the Cursor session " +
			"valid, is the local shim actually bound, and does ZCode's provider entry point at the URL " +
			"the shim is really serving. Read-only — it never changes anything, so it is safe to run " +
			"when something is broken. Use this first when a model in the picker fails, when the shim " +
			"seems dead, or after an install or restart, rather than inferring the state from symptoms.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		run: async () => {
			const lines = [];
			const faults = [];

			// 1. Credential.
			const status = await auth.status();
			if (status.authenticated) {
				const expiry = status.expiresAt ? new Date(status.expiresAt).toISOString() : "unknown";
				lines.push(`  ok    Cursor session valid${status.account ? ` (${status.account})` : ""}, expires ${expiry}`);
			} else {
				faults.push("no Cursor session stored");
				lines.push("  FAIL  no Cursor session — run cursor_import");
			}

			// 2. Shim. Asked of the socket, never of the recorded decision: an
			//    adopted port whose owner has since exited reports as healthy to
			//    anything that only remembers that it adopted.
			const outcome = await shim.servingState();
			if (!outcome.ok) {
				faults.push(`the shim is not serving: ${outcome.reason}`);
				lines.push(`  FAIL  shim not serving — ${outcome.reason}`);
			} else if (outcome.adopted) {
				lines.push(`  ok    shim answering on ${shim.host}:${shim.port} (served by another instance)`);
			} else {
				lines.push(`  ok    shim listening on ${shim.host}:${shim.port}${shim.movedPort ? ` (moved from ${shim.preferredPort})` : ""}`);
			}
			// 3. The provider entry, and whether it agrees with the shim. This is
			//    the check that catches a moved port, which is individually
			//    healthy on both sides and completely broken together.
			const actual = outcome.ok ? `http://${shim.host}:${shim.port}/v1` : undefined;
			// The invariant. Cursor asking for a tool and the host receiving one are
			// two separate counts, and a gap between them is the exact signature of
			// tool calling silently not working — visible here without ever running a
			// model. This is the check that would have caught the original defect on
			// the first turn instead of after a user noticed.
			const metrics = shim.metrics();
			// Anything the host asked for that this protocol cannot express. Naming
			// it is the difference between "the shim is broken" and "the shim is
			// approximating, and here is exactly where".
			for (const note of metrics.approximations ?? []) {
				lines.push(`  warn  ${note}`);
			}
			if (metrics.droppedToolCalls > 0) {
				faults.push(
					`${metrics.droppedToolCalls} of ${metrics.toolRequests} tool requests never reached ` +
						"the host — Cursor asked for tools this session did not register",
				);
				lines.push(
					`  FAIL  ${metrics.droppedToolCalls}/${metrics.toolRequests} tool requests dropped ` +
						"(a tool Cursor called is missing from the host's tool list)",
				);
			} else if (metrics.toolRequests > 0) {
				lines.push(
					`  ok    ${metrics.toolRequests} tool request(s) from Cursor, all delivered to the host`,
				);
			}

			const provider = await inspectProviderConfig(
				actual ? { baseUrl: actual, apiKey: shim.apiKey } : {},
			);
			if (!provider.found) {
				const because = provider.error ? ` — ${provider.error}` : "";
				faults.push("no Cursor provider in ZCode's settings");
				lines.push(`  FAIL  no Cursor provider in ZCode's settings${because}`);
				lines.push("        Create it in Settings → Model Provider, then run cursor_register_models.");
			} else {
				const agreement = compareEndpoints(actual, provider.baseUrl);
				if (agreement.ok) {
					lines.push(
						`  ok    provider "${provider.providerName}" on ${provider.baseUrl}, ` +
							`${provider.models} models registered`,
					);
				} else {
					faults.push("the provider's base URL does not match the shim");
					lines.push(`  FAIL  provider "${provider.providerName}" — ${agreement.detail}`);
				}
				if (provider.apiKeyMatches === false) {
					faults.push("the provider's API key does not match the shim's");
					lines.push(
						"  FAIL  the provider's API key is stale — every request is refused with 401.",
					);
					lines.push(
						"        Re-run /connect-cursor-and-initialize to write the current key.",
					);
				}
				if (provider.models === 0) {
					faults.push("the provider has no models, so nothing appears in the picker");
					lines.push("  FAIL  the provider has no models — the picker will be empty for it");
				}
			}

			const header = faults.length === 0 ? "Everything checks out." : `Found ${faults.length} problem(s):`;
			const restart = outcome.ok
				? ""
				: "\nThe shim could not start. If this is right after installing the plugin, the tools " +
					"may not be loaded in this session yet — quit ZCode completely (⌘Q) and reopen it.";

			return content(
				[header, "", ...lines, ...(faults.length > 0 ? ["", ...faults.map((f) => `  - ${f}`)] : []), restart].join(
					"\n",
				),
				faults.length > 0,
			);
		},
	},
	{
		name: "cursor_status",
		description: "Report whether Cursor is signed in, plus the shim's own health counters.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		run: async () => {
			const status = await auth.status();
			const metrics = shim.metrics();
			const outcome = await shim.servingState();
			const lines = [status.authenticated ? "Signed in." : "Not signed in — run cursor_login."];
			if (status.account) lines.push(`Account: ${status.account}`);
			if (status.expiresAt) {
				lines.push(`Token valid until: ${new Date(status.expiresAt).toISOString()}`);
			}
			lines.push(
				`Shim: ${metrics.turns} turns, ${metrics.resumed} resumed, ${metrics.replayed} ` +
					`replayed (resume rate ${metrics.resumeRate}), ` +
					`${metrics.conversations} resumable conversations.`,
			);
			lines.push(
				`Tools: ${metrics.toolRequests} requested by Cursor, ${metrics.toolCalls} delivered to ` +
					`the host, ${metrics.droppedToolCalls} dropped.`,
			);
			if (!outcome.ok) {
				lines.push(`Not serving: ${outcome.reason}.`);
			} else if (outcome.adopted) {
				lines.push(
					`Answering on http://${shim.host}:${shim.port}/v1, served by another instance.`,
				);
			} else {
				lines.push(`Listening on http://${shim.host}:${shim.port}/v1`);
			}
			if (shim.movedPort) {
				lines.push(
					`Port moved from ${shim.preferredPort}, which was already taken. ` +
						"The provider's base URL must match the one above.",
				);
			}
			return content(lines.join("\n"));
		},
	},
	{
		name: "cursor_uninstall",
		description:
			"Completely remove this plugin from the machine: delete the stored Cursor credential, " +
			"remove the Cursor provider and its model rules from ZCode's config, stop the local shim, " +
			"and delete the plugin's install record, cache and data directory. Use this when the user " +
			"wants to uninstall or start over, so that reinstalling later comes up completely fresh. " +
			"The marketplace registration is kept, so the plugin can be installed again. " +
			"Only use cursor_logout if the user just wants to sign out but keep the plugin installed.",
		inputSchema: {
			type: "object",
			properties: {
				confirmed: {
					type: "boolean",
					description:
						"Set true once the user has agreed to uninstall. Omit it first to see what will be removed.",
				},
			},
		},
		explain: async () =>
			content(
				[
					"This removes everything Cursor Subscription added to this machine:",
					"",
					"  - the stored Cursor credential (you will need to sign in again to use it)",
					"  - the Cursor provider entry and its model rules in ZCode's settings",
					"  - the running local shim and the port it holds",
					"  - the plugin's install record, cache and data directory",
					"",
					"Other providers and the marketplace registration are left alone, so you can install " +
					"the plugin again and start clean.",
					"",
					"ZCode will need to restart afterwards. Continue?",
				].join("\n"),
			),
		run: async () => {
			const baseUrl = await shimBaseUrl().catch(() => `http://${shim.host}:${shim.port}/v1`);
			const steps = [];

			// Provider first. It is the leftover that keeps showing up in the model
			// picker after the plugin is gone, and it does not depend on any code
			// this uninstall is about to delete.
			const provider = await removeShimProvider({ baseUrl });
			steps.push(
				provider.ok
					? provider.reason === "not-registered"
						? "Cursor provider: already removed"
						: `Cursor provider "${provider.providerName}" and ${provider.models} model rules removed`
					: `Cursor provider: NOT removed — ${provider.reason}`,
			);

			// Then the credential. Report what was actually there: a re-run must
			// not claim to have deleted something that was already gone.
			try {
				const before = await store.status();
				await auth.logout();
				steps.push(
					before.authenticated
						? `Cursor credential for ${before.account ?? "the signed-in account"} deleted`
						: "Cursor credential: already signed out",
				);
			} catch (error) {
				steps.push(`Cursor credential: NOT deleted — ${error.message}`);
			}

			// Then the shim, so the port frees and the in-memory token is dropped.
			try {
				const outcome = await shim.bound;
				if (outcome?.ok && !outcome.adopted) {
					await shim.close();
					steps.push(`Shim stopped, port ${shim.port} released`);
				} else if (outcome?.adopted) {
					steps.push(
						`Shim: another instance is serving port ${shim.port} and was left running — ` +
							"quit ZCode to stop it",
					);
				}
			} catch (error) {
				steps.push(`Shim: could not stop cleanly — ${error.message}`);
			}

			// Last, because from here on this process is running from files that
			// are about to disappear.
			const install = await removePluginInstallation();
			for (const item of install.removed) {
				steps.push(`Removed ${item}`);
			}
			for (const problem of install.problems) {
				steps.push(`Could not remove ${problem}`);
			}

			const failed = steps.some((s) => /\bNOT\b|Could not/.test(s));
			return content(
				[
					failed ? "Uninstall finished with problems:" : "Uninstalled.",
					"",
					...steps.map((s) => `  - ${s}`),
					"",
					"Quit ZCode completely (⌘Q) and reopen it. That finishes the removal — this " +
						"process is still running from files that no longer exist.",
					"",
					"The marketplace is still registered, so you can install Cursor Subscription again " +
						"whenever you want. It will come up signed out and with no provider, which is the " +
						"clean start; run /connect-cursor to set it up again.",
				].join("\n"),
				failed,
			);
		},
	},
	{
		name: "cursor_logout",
		description:
			"Delete the stored Cursor credential from this machine, keeping the plugin installed. " +
			"Use cursor_uninstall instead if the user wants the plugin removed entirely.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		explain: async () => content("This deletes the stored Cursor credential. Continue?"),
		run: async () => {
			await auth.logout();
			shim.resetMetrics();
			return content("Signed out. The local Cursor credential was deleted.");
		},
	},
	{
		name: "cursor_models",
		description: "List the Cursor models available to the signed-in account.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		run: async () => {
			try {
				const token = await auth.accessToken();
				const models = sortModelsByName(await fetchUsableModels(token));
				return content(models.length ? models.join("\n") : FALLBACK_MODELS.join("\n"));
			} catch (error) {
				return content(
					`Could not read Cursor's model list (${error.message}). ` +
						"Showing the built-in fallback list instead.",
				);
			}
		},
	},
];

// --- JSON-RPC over stdio ----------------------------------------------------

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

async function handle(message) {
	const { id, method, params } = message ?? {};
	const reply = (result) => id !== undefined && send({ jsonrpc: "2.0", id, result });
	const fail = (code, msg) => id !== undefined && send({ jsonrpc: "2.0", id, error: { code, message: msg } });

	switch (method) {
		case "initialize":
			return reply({
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: "cursor-subscription", version: "0.6.0" },
			});
		case "notifications/initialized":
			return;
		case "tools/list":
			return reply({
				tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
			});
		case "tools/call": {
			const tool = TOOLS.find((t) => t.name === params?.name);
			if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
			const args = params?.arguments ?? {};
			try {
				// Mutating tools show their notice first; the host re-invokes with
				// `confirmed: true` to proceed.
				if (tool.explain && args.confirmed !== true) {
					return reply(await tool.explain(args));
				}
				return reply(await tool.run(args));
			} catch (error) {
				// An import failure carries a reason and the action that fixes it.
				// Report both so the user is told what to do, not just that it broke.
				if (error?.advice) {
					return reply(
						content(
							`${error.advice}\n\n(detail: ${error.message}, code: ${error.code})`,
							true,
						),
					);
				}
				return reply(content(String(error?.message ?? error), true));
			}
		}
		default:
			return fail(-32601, `Method not found: ${method}`);
	}
}

const input = createInterface({ input: process.stdin });
input.on("line", async (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;
	let message;
	try {
		message = JSON.parse(trimmed);
	} catch {
		return;
	}
	try {
		await handle(message);
	} catch (error) {
		const id = message?.id;
		if (id !== undefined) {
			send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(error?.message ?? error) } });
		}
	}
});

// Start the shim alongside the tool server so a single MCP launch is enough to
// make the provider work. A taken port is not an error: the shim either adopts
// a healthy instance already serving it, or moves to the next free port. It
// must never be fatal — this process also carries the management tools.
shim.listen();
shim.bound?.then((outcome) => {
	if (!outcome.ok) {
		process.stderr.write(
			`cursor-subscription: not serving the shim (${outcome.error?.message}). ` +
				"The management tools below still work.\n",
		);
		return;
	}
	if (outcome.adopted) {
		process.stderr.write(
			`cursor-subscription: another shim already serves ${shim.host}:${shim.port}; ` +
				"this process is not serving it. The management tools below still work.\n",
		);
	} else if (shim.movedPort) {
		process.stderr.write(
			`cursor-subscription: port ${shim.preferredPort} was taken, so the shim is on ` +
				`${shim.host}:${shim.port}. Point the ZCode provider at http://${shim.host}:${shim.port}/v1\n`,
		);
	}
	// A reinstall rotates the shim key, and ZCode can then write a provider entry
	// back holding the old one, so every chat turn 401s. Repair it here rather
	// than letting the user meet a bare "invalid api key" in the UI.
	reconcileProviderKey({
		baseUrl: `http://${shim.host}:${shim.port}/v1`,
		apiKey: shim.apiKey,
	})
		.then((result) => {
			if (result.repaired) {
				process.stderr.write(
					`cursor-subscription: updated the API key on provider "${result.providerName}", ` +
						"which was stale after a reinstall.\n",
				);
			}
		})
		.catch(() => {});
});

export { shim, CONSENT_NOTICE, TOOLS };
