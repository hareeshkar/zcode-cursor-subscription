/**
 * Cursor OAuth: PKCE browser sign-in, token polling, and refresh.
 *
 * Ported from `dsh-cursor-subscription` (MIT, orrinzeng) — see NOTICE.md.
 *
 * The flow has no callback port: we open Cursor's deep-link login page, then
 * poll a request-scoped endpoint until it hands back a token pair.
 *
 * @module cursor-subscription/auth
 */

import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";

import {
	CURSOR_AUTH_ORIGIN,
	CURSOR_BASE_URL,
	CURSOR_LOGIN_URL,
	CURSOR_POLL_PATH,
	CURSOR_REFRESH_PATH,
	CURSOR_MODELS_PATH,
	DEFAULT_TOKEN_LIFETIME_MS,
	REFRESH_AHEAD_MS,
} from "./config.mjs";
import { Credential } from "./credentials.mjs";

/** Error carrying a stable code so callers can branch without string matching. */
export class AuthError extends Error {
	constructor(message, code = "AUTH_FAILED", options) {
		super(message, options);
		this.name = "AuthError";
		this.code = code;
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Generate a PKCE verifier/challenge pair. */
export async function generatePkce() {
	const verifierBytes = new Uint8Array(96);
	globalThis.crypto.getRandomValues(verifierBytes);
	const verifier = Buffer.from(verifierBytes).toString("base64url");
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	return { verifier, challenge: Buffer.from(digest).toString("base64url") };
}

/** Build the browser login URL for the PKCE flow. */
export function buildLoginUrl({ challenge, uuid }) {
	const params = new URLSearchParams({
		challenge,
		uuid,
		mode: "login",
		redirectTarget: "cli",
	});
	return `${CURSOR_LOGIN_URL}?${params.toString()}`;
}

/**
 * Read a JWT `exp` claim, in ms.
 * Falls back to a default lifetime when the token is not a readable JWT.
 */
export function getTokenExpiry(token, now = Date.now) {
	try {
		const parts = token.split(".");
		if (parts.length !== 3 || !parts[1]) return now() + DEFAULT_TOKEN_LIFETIME_MS;
		const decoded = JSON.parse(
			Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
		);
		if (decoded && typeof decoded === "object" && typeof decoded.exp === "number") {
			return decoded.exp * 1000;
		}
	} catch {
		// fall through to the default
	}
	return now() + DEFAULT_TOKEN_LIFETIME_MS;
}

/**
 * Read the `sub` claim and strip the identity-provider prefix
 * (`github|user_…` → `user_…`). Used only to label the account; never a secret.
 */
export function getTokenSub(token) {
	try {
		const parts = token.split(".");
		if (parts.length !== 3 || !parts[1]) return undefined;
		const decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		if (typeof decoded?.sub !== "string" || decoded.sub.length === 0) return undefined;
		return decoded.sub.includes("|") ? decoded.sub.split("|").pop() : decoded.sub;
	} catch {
		return undefined;
	}
}

/**
 * Validate the one external origin this plugin is allowed to open.
 *
 * The login URL is the only thing we ever hand to a browser, so it is pinned
 * to HTTPS on exactly `cursor.com` with no embedded credentials.
 */
export function assertCursorAuthUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new AuthError("Cursor auth URL is invalid");
	}
	if (url.protocol !== "https:") throw new AuthError("Cursor auth URL must use HTTPS");
	if (url.origin !== CURSOR_AUTH_ORIGIN || url.username !== "" || url.password !== "") {
		throw new AuthError("Cursor auth URL must use the cursor.com origin");
	}
	return url.href;
}

/** Shell-free opener for the current desktop. */
function openerFor(url, platform = process.platform) {
	if (platform === "win32") return { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
	if (platform === "darwin") return { file: "open", args: [url] };
	if (platform === "linux") return { file: "xdg-open", args: [url] };
	throw new AuthError(`Cursor auth URL opener is unsupported on ${platform}`);
}

/** Open the Cursor login page. Never uses a shell. */
export function openCursorAuthUrl(value, options = {}) {
	const command = openerFor(assertCursorAuthUrl(value), options.platform ?? process.platform);
	const spawnProcess = options.spawn ?? spawn;
	return new Promise((resolve, reject) => {
		const child = spawnProcess(command.file, command.args, {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
			// shell:false is the default, stated explicitly because passing a
			// browser URL through a shell is how tokens leak into shell history.
			shell: false,
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

/**
 * Owns the Cursor OAuth lifecycle.
 *
 * The browser is only ever shown the login URL; the token pair stays in the
 * process and lands directly in the credential store.
 */
export class CursorAuthService {
	#store;
	#fetch;
	#now;

	constructor(store, options = {}) {
		this.#store = store;
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#now = options.now ?? Date.now;
	}

	async status() {
		return this.#store.status();
	}

	/**
	 * Resolve a usable access token, refreshing first when the stored token is
	 * missing, expired, or about to expire.
	 */
	async accessToken(options = {}) {
		const credential = await this.credential(options);
		return credential.access;
	}

	/** Resolve the stored credential, refreshing when it is near expiry. */
	async credential({ signal } = {}) {
		signal?.throwIfAborted();
		const current = await this.#store.read();
		if (current === undefined) {
			throw new AuthError("Cursor subscription is not signed in", "MISSING_CREDENTIAL");
		}
		if (current.expires - this.#now() > REFRESH_AHEAD_MS) return current;
		return this.refresh(current, { signal });
	}

	async refresh(current, { signal } = {}) {
		const response = await this.#fetch(`${CURSOR_BASE_URL}${CURSOR_REFRESH_PATH}`, {
			method: "POST",
			redirect: "error",
			headers: {
				authorization: `Bearer ${current.refresh}`,
				"content-type": "application/json",
				accept: "application/json",
			},
			body: "{}",
			signal,
		});
		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				throw new AuthError("Cursor sign-in needs to be renewed", "INVALID_CREDENTIAL");
			}
			throw new AuthError(`Cursor token refresh failed (HTTP ${response.status})`);
		}
		let data;
		try {
			data = await response.json();
		} catch (cause) {
			throw new AuthError("Cursor returned an unreadable token response", "AUTH_FAILED", { cause });
		}
		if (typeof data?.accessToken !== "string" || data.accessToken.length === 0) {
			throw new AuthError("Cursor sign-in needs to be renewed", "INVALID_CREDENTIAL");
		}
		const next = new Credential({
			access: data.accessToken,
			// Cursor sometimes omits a new refresh token; keep the current one.
			refresh:
				typeof data.refreshToken === "string" && data.refreshToken.length > 0
					? data.refreshToken
					: current.refresh,
			expires: getTokenExpiry(data.accessToken, this.#now),
			sub: getTokenSub(data.accessToken),
		});
		// Compare-and-swap: only apply if nobody else rotated past our token.
		return (await this.#store.modify(current.refresh, () => next)) ?? next;
	}

	/**
	 * Run the browser sign-in to completion.
	 *
	 * @param {{ onUrl?: (url: string) => void, signal?: AbortSignal }} options
	 * @returns {Promise<{ authenticated: true, expiresAt: number, account?: string }>}
	 */
	async login({ onUrl, signal } = {}) {
		signal?.throwIfAborted();
		const { verifier, challenge } = await generatePkce();
		const uuid = randomUUID();
		const loginUrl = assertCursorAuthUrl(buildLoginUrl({ challenge, uuid }));

		// Hand the URL back before opening, so a caller can show it (or print
		// it) in a context where spawning a browser is not wanted.
		onUrl?.(loginUrl);
		await openCursorAuthUrl(loginUrl).catch(() => {
			// A failed spawn is not fatal: the caller already has the URL.
		});

		let delay = 1_000;
		for (let attempt = 0; attempt < 150; attempt += 1) {
			await sleep(delay);
			signal?.throwIfAborted();
			let response;
			try {
				response = await this.#fetch(
					`${CURSOR_BASE_URL}${CURSOR_POLL_PATH}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`,
					{
						redirect: "error",
						headers: { accept: "application/json" },
						signal,
					},
				);
			} catch (cause) {
				throw new AuthError("Cursor login poll request failed", "AUTH_FAILED", { cause });
			}
			if (response.status === 404) {
				// Not authorised yet — back off and keep polling.
				delay = Math.min(delay * 1.2, 10_000);
				continue;
			}
			if (!response.ok) {
				throw new AuthError(`Cursor login poll failed (HTTP ${response.status})`);
			}
			const text = await Promise.resolve(response.text()).catch(() => "");
			let data;
			try {
				data = JSON.parse(text);
			} catch {
				// Never echo the body: it is an auth response.
				throw new AuthError("Cursor login returned an unreadable response");
			}
			if (typeof data?.accessToken !== "string" || data.accessToken.length === 0) {
				throw new AuthError("Cursor login returned no access token");
			}
			const credential = new Credential({
				access: data.accessToken,
				refresh: typeof data.refreshToken === "string" ? data.refreshToken : "",
				expires: getTokenExpiry(data.accessToken, this.#now),
				sub: getTokenSub(data.accessToken),
			});
			await this.#store.save(credential);
			return this.#store.status();
		}
		throw new AuthError("Cursor login timed out");
	}

	/**
	 * Adopt a Cursor session from a local Cursor installation.
	 *
	 * A user who already has Cursor set up should not have to sign in again.
	 * The token is verified against Cursor before it is stored, so a stale local
	 * session fails here rather than at the first chat turn.
	 */
	async importLocal() {
		const { readLocalToken } = await import("./import-local.mjs");
		const found = readLocalToken();
		if ("error" in found) {
			// Carry the reason and the advice so the caller can branch and the
			// user is told what to do, rather than the agent interpreting prose.
			const error = new AuthError(found.error, found.reason);
			error.advice = found.advice;
			throw error;
		}
		// Verify before persisting.
		const response = await this.#fetch(
			`${CURSOR_BASE_URL}${CURSOR_MODELS_PATH}`,
			{
				method: "POST",
				redirect: "error",
				headers: {
					"content-type": "application/proto",
					authorization: `Bearer ${found.token}`,
				},
				body: new Uint8Array(0),
			},
		);
		if (!response.ok) {
			const { ImportFailure, IMPORT_ADVICE } = await import("./import-local.mjs");
			const error = new AuthError(
				`The local Cursor session was rejected (HTTP ${response.status})`,
				ImportFailure.REJECTED,
			);
			error.advice = IMPORT_ADVICE[ImportFailure.REJECTED];
			throw error;
		}
		const credential = new Credential({
			access: found.token,
			refresh: "",
			expires: getTokenExpiry(found.token, this.#now),
			sub: getTokenSub(found.token),
		});
		await this.#store.save(credential);
		return this.#store.status();
	}

	async logout() {
		await this.#store.clear();
		return this.#store.status();
	}
}

export { createHash };
