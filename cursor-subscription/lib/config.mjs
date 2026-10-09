/**
 * Shared constants and defaults.
 *
 * Everything here is a protocol or transport detail of Cursor's Agent service,
 * gathered in one place so a Cursor-side change is a one-file edit.
 *
 * @module cursor-subscription/config
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const PLUGIN_ID = "cursor-subscription";

// --- Cursor endpoints -------------------------------------------------------

export const CURSOR_BASE_URL = process.env.CURSOR_API_BASE_URL ?? "https://api2.cursor.sh";
export const CURSOR_AUTH_ORIGIN = "https://cursor.com";
export const CURSOR_LOGIN_URL = `${CURSOR_AUTH_ORIGIN}/loginDeepControl`;
export const CURSOR_POLL_PATH = "/auth/poll";
export const CURSOR_REFRESH_PATH = "/auth/exchange_user_api_key";
export const CURSOR_RUN_PATH = "/agent.v1.AgentService/Run";
export const CURSOR_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";

/**
 * Client version reported to the Agent service. Bump when Cursor requires it.
 * Kept as its own constant because it is the single most likely thing to break:
 * Cursor gates on it and the value moves with every CLI release.
 */
export const CURSOR_CLIENT_VERSION = "cli-2026.02.13-41ac335";

/** Request headers for the streaming agent run. */
export const AGENT_HEADERS = Object.freeze({
	"content-type": "application/connect+proto",
	"connect-protocol-version": "1",
	"connect-accept-encoding": "gzip",
	te: "trailers",
	"x-ghost-mode": "true",
	"x-cursor-client-version": CURSOR_CLIENT_VERSION,
	"x-cursor-client-type": "cli",
});

// --- Usage dashboard (session-cookie authenticated) ------------------------

export const USAGE_API_ORIGIN = "https://cursor.com";
export const USAGE_URL = `${USAGE_API_ORIGIN}/api/usage`;
export const USAGE_SUMMARY_URL = `${USAGE_API_ORIGIN}/api/usage-summary`;
export const USAGE_TEAMS_URL = `${USAGE_API_ORIGIN}/api/dashboard/teams`;
export const USAGE_AGGREGATED_URL = `${USAGE_API_ORIGIN}/api/dashboard/get-aggregated-usage-events`;
export const USAGE_TTL_MS = 60 * 1000;
export const MAX_USAGE_MODELS = 20;

// --- Timing ----------------------------------------------------------------

export const HEARTBEAT_INTERVAL_MS = 5_000;
export const STREAM_IDLE_TIMEOUT_MS = 120_000;
export const STREAM_PROGRESS_TIMEOUT_MS = 60_000;
/** A resumed Cursor conversation older than this is replayed instead. */
export const SESSION_STATE_TTL_MS = 30 * 60 * 1000;
/** Sibling tool calls of one burst land within ~100 ms of each other. */
export const TOOL_CALL_SETTLE_MS = 500;
/** Refresh the access token this early before its JWT expiry. */
export const REFRESH_AHEAD_MS = 5 * 60 * 1000;
/** Fallback lifetime when a JWT carries no usable `exp`. */
export const DEFAULT_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

// --- Model limits ----------------------------------------------------------

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_MAX_TOKENS = 64_000;

/** Used when `GetUsableModels` is unreachable. */
export const FALLBACK_MODELS = Object.freeze([
	"composer-2",
	"claude-4-sonnet",
	"claude-4-opus",
	"gpt-5",
	"gpt-5-codex",
	"gemini-3-pro",
	"grok-4",
]);

// --- Shim ------------------------------------------------------------------

export const DEFAULT_SHIM_PORT = Number(process.env.CURSOR_SHIM_PORT ?? 8477);
export const SHIM_HOST = "127.0.0.1";
/** Bind strictly to loopback: the shim holds a live Cursor bearer token. */
export const SHIM_API_KEY = process.env.CURSOR_SHIM_KEY ?? "";

/**
 * How far past the default port to look for a free one.
 *
 * A short scan on purpose: the shim must not wander far from a port the user
 * may already have typed into Settings, and a wide scan would start binding
 * ports that belong to unrelated local services.
 */
export const PORT_SCAN_RANGE = 12;

/**
 * How often a process that adopted another shim's port checks the peer is alive.
 *
 * Two ZCode sessions is normal, and whichever loses the port race holds a dead
 * port for the rest of the session unless it checks. Short enough to recover
 * before a user notices, long enough to cost nothing.
 */
export const ADOPTION_CHECK_INTERVAL_MS = 10_000;

/** The OpenAI-compatible surface this shim serves, printed for setup. */
export const SHIM_PATHS = Object.freeze({
	chat: "/v1/chat/completions",
	models: "/v1/models",
	health: "/health",
});

// --- Local state -----------------------------------------------------------

/**
 * Where credentials live. ZCode hands plugins a private data directory; fall
 * back to a dotfile only when running the shim standalone.
 */
export function dataDir() {
	const fromEnv = process.env.CURSOR_SUBSCRIPTION_DATA ?? process.env.ZCODE_PLUGIN_DATA;
	if (fromEnv) return fromEnv;
	return join(homedir(), ".cursor-subscription");
}

/**
 * Custom model ids that are usable through Cursor's agent even though the
 * GetUsableModels catalog omits them.
 *
 * Live example (2026-10): `glm-5p3-flash` / `glm-5p3-flash-high` answer real
 * completions through agent.v1 on accounts the IDE shows them to, while the
 * catalog endpoint keeps returning the older glm-5.2 set — a staged rollout
 * the IDE learns about through its own settings path. The workaround that
 * needs no reverse-engineering of that path: let the user (or their session)
 * name the ids once, here. Both sources are read and merged:
 *
 *  - `CURSOR_CUSTOM_MODELS` — comma/whitespace-separated ids, for one-off runs
 *  - `<data dir>/custom-models.json` — a JSON array, persisted across runs
 *
 * Ids are validated cheaply (id-shaped: lowercase, digits, dots, dashes,
 * underscores). Everything downstream probes before it publishes, so a wrong
 * id costs one failed probe, never a broken picker.
 */
export function parseCustomModelIds(value) {
	if (typeof value !== "string" || value.trim().length === 0) return [];
	return [
		...new Set(
			value
				.split(/[\s,]+/)
				.map((id) => id.trim())
				.filter((id) => /^[a-z0-9][a-z0-9._-]*$/i.test(id)),
		),
	];
}

/** The configured custom model ids from both sources, env first. */
export function customModelIds() {
	const ids = new Set(parseCustomModelIds(process.env.CURSOR_CUSTOM_MODELS));
	try {
		const raw = readFileSync(join(dataDir(), "custom-models.json"), "utf8");
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			for (const id of parseCustomModelIds(parsed.join(","))) ids.add(id);
		}
	} catch {
		// No file, or unreadable: env alone is fine.
	}
	return [...ids];
}

export function credentialsPath() {
	return join(dataDir(), "credentials.json");
}

/**
 * Where the port actually bound is remembered.
 *
 * The shim will move off its preferred port when something else already holds
 * it, and ZCode routes traffic to a literal base URL. So the port has to be
 * *stable* across restarts rather than freshly chosen on every launch — a new
 * random port each time would point the provider at a dead address on every
 * restart. Remembering the winner is what makes the fallback safe.
 */
export function portPath() {
	return join(dataDir(), "shim-port");
}

/** The last port that successfully served, or undefined if never recorded. */
export function readRecordedPort() {
	try {
		const value = Number(readFileSync(portPath(), "utf8").trim());
		return Number.isInteger(value) && value > 0 && value < 65_536 ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Persist a successful bind. Non-fatal: the port still works for this process. */
export function recordPort(port) {
	try {
		mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
		writeFileSync(portPath(), `${port}\n`, { mode: 0o600 });
	} catch {
		// Non-fatal.
	}
}
