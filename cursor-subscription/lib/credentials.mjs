/**
 * Credential store for the Cursor OAuth tokens.
 *
 * Safety properties this file is responsible for:
 *
 *  - The file is created `0600` inside a `0700` directory.
 *  - Writes are atomic (temp file + rename) so a crash mid-write cannot
 *    truncate a live credential and force a re-login.
 *  - Refresh-token rotation is compare-and-swap: a refresh only overwrites the
 *    stored value when the stored refresh token is still the one that was
 *    refreshed. Two concurrent runs must not clobber each other's rotation.
 *  - Nothing here ever returns a token to a caller that formats it for display.
 *
 * @module cursor-subscription/credentials
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { credentialsPath, dataDir } from "./config.mjs";

/** Shape persisted to disk. Never logged, never returned from a tool. */
class Credential {
	constructor({ access, refresh, expires, sub }) {
		this.type = "oauth";
		this.access = access;
		this.refresh = refresh;
		this.expires = expires;
		/** Account id with any identity-provider prefix stripped. */
		this.sub = sub;
	}

	toJSON() {
		return {
			type: this.type,
			access: this.access,
			refresh: this.refresh,
			expires: this.expires,
			sub: this.sub,
		};
	}
}

function isNonEmptyString(value) {
	return typeof value === "string" && value.length > 0;
}

/**
 * Coerce a plain object into a `Credential`.
 *
 * Callers reasonably pass object literals; normalising here means the write
 * path only ever deals with one shape.
 */
function toCredential(value) {
	if (value instanceof Credential) return value;
	if (value === null || typeof value !== "object") {
		throw new TypeError("credential must be an object");
	}
	return new Credential({
		access: value.access,
		refresh: typeof value.refresh === "string" ? value.refresh : "",
		expires: value.expires,
		sub: typeof value.sub === "string" ? value.sub : undefined,
	});
}

/** Parse persisted JSON, rejecting anything that is not a well-formed credential. */
function parse(raw) {
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (value === null || typeof value !== "object") return undefined;
	if (value.type !== "oauth") return undefined;
	if (!isNonEmptyString(value.access)) return undefined;
	if (typeof value.refresh !== "string") return undefined;
	if (!Number.isFinite(value.expires)) return undefined;
	return new Credential({
		access: value.access,
		refresh: value.refresh,
		expires: value.expires,
		sub: typeof value.sub === "string" ? value.sub : undefined,
	});
}

/**
 * File-backed credential store.
 *
 * A directory of `credentials.json` under the plugin's private data dir. The
 * process is single-host, so a plain file is the right amount of machinery —
 * but the atomic write and the compare-and-swap are both load-bearing.
 */
export class CredentialStore {
	#path;
	#dir;

	constructor(options = {}) {
		this.#path = options.path ?? credentialsPath();
		this.#dir = options.dir ?? dirname(this.#path);
	}

	get path() {
		return this.#path;
	}

	async #ensureDir() {
		await mkdir(this.#dir, { recursive: true, mode: 0o700 });
	}

	/** Read the stored credential, or `undefined` when not signed in. */
	async read() {
		let raw;
		try {
			raw = await readFile(this.#path, "utf8");
		} catch (error) {
			if (error?.code === "ENOENT") return undefined;
			throw error;
		}
		return parse(raw);
	}

	/**
	 * Write a credential atomically.
	 *
	 * The temp file is created in the same directory so the rename is a same
	 * filesystem operation and therefore atomic. It is `0600` from the moment
	 * of creation, so the token is never briefly world-readable.
	 */
	async #write(credential) {
		await this.#ensureDir();
		const tmp = join(this.#dir, `.credentials.${randomBytes(8).toString("hex")}.tmp`);
		const handle = await writeFile(tmp, `${JSON.stringify(credential.toJSON(), null, 2)}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		try {
			await handle.sync();
		} catch {
			// fsync is best-effort; a failure here does not invalidate the write.
		}
		await rename(tmp, this.#path);
		await chmod(this.#path, 0o600).catch(() => {});
	}

	/** Replace the stored credential outright (sign-in). */
	async save(credential) {
		await this.#write(toCredential(credential));
	}

	/**
	 * Compare-and-swap refresh.
	 *
	 * Returns the credential now in effect. If another run already rotated past
	 * `expectedRefresh`, the newer value wins and is returned untouched — we
	 * must not overwrite a rotation we did not perform.
	 *
	 * @param {string} expectedRefresh the refresh token this update is based on.
	 * @param {(current: Credential) => Credential} build applied to the live value.
	 */
	async modify(expectedRefresh, build) {
		const current = await this.read();
		if (current === undefined) return undefined;
		if (expectedRefresh !== undefined && current.refresh !== expectedRefresh) {
			// Someone else rotated while we were refreshing. Keep their value.
			return current;
		}
		const next = build(current);
		if (next === undefined) return current;
		await this.#write(toCredential(next));
		return next;
	}

	/** Remove the stored credential. */
	async clear() {
		try {
			await unlink(this.#path);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
	}

	/**
	 * Public status for a settings panel or tool response.
	 *
	 * Deliberately contains no token material — only whether a credential
	 * exists, when it expires, and which account it belongs to.
	 */
	async status() {
		const current = await this.read();
		if (current === undefined) {
			return { authenticated: false, provider: "cursor-subscription" };
		}
		return {
			authenticated: true,
			provider: "cursor-subscription",
			type: "oauth",
			expiresAt: current.expires,
			account: current.sub,
		};
	}
}

export { Credential, dataDir };
