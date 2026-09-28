/**
 * Import a Cursor session from a local Cursor installation.
 *
 * A user who already has Cursor set up should not have to sign in again through
 * a browser just to use the same account here. Both the reference project
 * (`--cursor-import-local`) and our own live testing confirmed the local install
 * holds a bearer token that authenticates against `agent.v1` directly.
 *
 * Where it lives, per platform:
 *   macOS    ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 *   Linux    ~/.config/Cursor/User/globalStorage/state.vscdb
 *   Windows  %APPDATA%/Cursor/User/globalStorage/state.vscdb
 *
 * The value is a `cursorAuth/accessToken` row in a SQLite key/value table. Node
 * ships `node:sqlite`, so this needs no dependency — which matters, because a
 * plugin that cannot install a native module is a plugin that works.
 *
 * @module cursor-subscription/import-local
 */

import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/** Candidate state databases, most specific first. */
export function stateDbCandidates() {
	const home = homedir();
	if (platform() === "darwin") {
		return [join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb")];
	}
	if (platform() === "win32") {
		const appData = process.env.APPDATA ?? join(home, "AppData/Roaming");
		return [join(appData, "Cursor/User/globalStorage/state.vscdb")];
	}
	return [
		join(home, ".config/Cursor/User/globalStorage/state.vscdb"),
		join(home, ".config/Cursor - OSS/User/globalStorage/state.vscdb"),
	];
}

/** The state database that actually exists, or undefined. */
export function findStateDb() {
	return stateDbCandidates().find((path) => existsSync(path));
}

/**
 * Read a key from a Cursor `state.vscdb`.
 *
 * The file may be locked by a running Cursor, so it is opened read-only and a
 * failure is reported rather than thrown — a locked database is a normal state,
 * not an error worth crashing on.
 *
 * @returns {string | undefined} the stored value, or undefined.
 */
export function readStateValue(key, dbPath = findStateDb()) {
	if (!dbPath || !existsSync(dbPath)) return undefined;
	let db;
	try {
		// Required lazily: `node:sqlite` is unavailable on Node < 22, and the
		// rest of the plugin must still load there.
		const { DatabaseSync } = require_sqlite();
		db = new DatabaseSync(dbPath, { readOnly: true });
		const row = db
			.prepare("SELECT value FROM ItemTable WHERE key = ?")
			.get(key);
		return row?.value ?? undefined;
	} catch {
		return undefined;
	} finally {
		try {
			db?.close();
		} catch {
			// ignore
		}
	}
}

let sqliteModule = null;
function require_sqlite() {
	if (sqliteModule === null) {
		throw new Error("node:sqlite is unavailable on this Node version");
	}
	return sqliteModule;
}

/** Load `node:sqlite` if this runtime has it. Returns whether it does. */
export function loadSqlite() {
	try {
		sqliteModule = sqliteModule ?? createRequire(import.meta.url)("node:sqlite");
		return true;
	} catch {
		return false;
	}
}

import { createRequire } from "node:module";

/**
 * Why an import could not produce a credential.
 *
 * These are distinct because the user has to do something different for each,
 * and prose alone leaves the agent guessing. `NOT_INSTALLED` means install
 * Cursor; `NOT_SIGNED_IN` means sign in; `REJECTED` means the stored session
 * exists but Cursor will not accept it.
 */
export const ImportFailure = Object.freeze({
	NOT_INSTALLED: "not-installed",
	NOT_SIGNED_IN: "not-signed-in",
	REJECTED: "rejected",
	UNSUPPORTED_RUNTIME: "unsupported-runtime",
});

/** What the user should actually do about each failure. */
export const IMPORT_ADVICE = Object.freeze({
	[ImportFailure.NOT_INSTALLED]:
		"No Cursor is installed on this machine. Install Cursor from cursor.com, sign in there, then run this again.",
	[ImportFailure.NOT_SIGNED_IN]:
		"Cursor is installed but not signed in. Open Cursor, sign in, and run this again — or use cursor_login to sign in through the browser instead.",
	[ImportFailure.REJECTED]:
		"Cursor rejected the saved session, so it is expired or revoked. Open Cursor and sign in again, then retry.",
	[ImportFailure.UNSUPPORTED_RUNTIME]:
		"This Node build has no node:sqlite, so a local session cannot be read. Use cursor_login instead.",
});

/**
 * Pull a Cursor bearer token out of a local install.
 *
 * @returns {{ token: string, source: string } | { error: string, reason: string, advice: string }}
 */
export function readLocalToken(dbPath = findStateDb()) {
	if (!loadSqlite()) {
		return {
			error: "node:sqlite is unavailable on this Node version",
			reason: ImportFailure.UNSUPPORTED_RUNTIME,
			advice: IMPORT_ADVICE[ImportFailure.UNSUPPORTED_RUNTIME],
		};
	}
	if (!dbPath) {
		return {
			error: "no local Cursor installation found",
			reason: ImportFailure.NOT_INSTALLED,
			advice: IMPORT_ADVICE[ImportFailure.NOT_INSTALLED],
		};
	}
	const raw = readStateValue("cursorAuth/accessToken", dbPath);
	if (typeof raw !== "string" || raw.trim().length === 0) {
		return {
			error: "Cursor is installed but holds no session",
			reason: ImportFailure.NOT_SIGNED_IN,
			advice: IMPORT_ADVICE[ImportFailure.NOT_SIGNED_IN],
		};
	}
	// Stored as "<uuid>.<token>.<signature>"; the whole value is what Cursor's own
	// client sends as the bearer, so it is used verbatim rather than split.
	return { token: raw.trim(), source: dbPath };
}
