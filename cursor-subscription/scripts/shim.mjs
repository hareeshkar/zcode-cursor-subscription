#!/usr/bin/env node
/**
 * Standalone shim entry point.
 *
 * Normally the shim is started by the MCP server, but it can also run on its
 * own — useful for pointing a provider at it during setup, and for verifying
 * the port and API key before touching the ZCode UI.
 *
 *   node scripts/shim.mjs --port 8477
 *
 * The API key is read from `CURSOR_SHIM_KEY`. If it is unset the shim refuses
 * every request rather than serving unauthenticated: it holds a live Cursor
 * bearer token, and ZCode requires a non-blank key for a provider entry anyway.
 *
 * @module cursor-subscription/shim-entry
 */

import { randomBytes } from "node:crypto";

import { CURSOR_CLIENT_VERSION, DEFAULT_SHIM_PORT, SHIM_HOST, dataDir } from "../lib/config.mjs";
import { CredentialStore } from "../lib/credentials.mjs";
import { CursorAuthService } from "../lib/auth.mjs";
import { CursorShim } from "../lib/shim.mjs";

const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = portIndex === -1 ? DEFAULT_SHIM_PORT : Number(args[portIndex + 1]);

if (!process.env.CURSOR_SHIM_KEY) {
	// Generate one and tell the user, rather than failing silently or serving
	// without authentication.
	const generated = randomBytes(24).toString("base64url");
	process.env.CURSOR_SHIM_KEY = generated;
	process.stderr.write(
		`cursor-subscription: generated a local API key for this run:\n  ${generated}\n` +
			"Paste it into the provider's API key field. Set CURSOR_SHIM_KEY to reuse one.\n",
	);
}

const store = new CredentialStore();
const shim = new CursorShim({
	store,
	auth: new CursorAuthService(store),
	apiKey: process.env.CURSOR_SHIM_KEY,
	port: Number.isFinite(port) ? port : DEFAULT_SHIM_PORT,
	host: SHIM_HOST,
	log: (message, detail) => process.stderr.write(`cursor-subscription: ${message}${detail ? ` (${detail})` : ""}\n`),
});

shim.listen();

// Standalone, this process *is* the provider, so the port it ended up on has
// to be stated before anything is configured against it. Waiting on `bound`
// first is what makes the announced URL the one that actually answers.
const outcome = await shim.bound;
if (!outcome.ok) {
	process.stderr.write(
		`cursor-subscription: cannot listen on ${shim.host}:${shim.preferredPort} or any port after it ` +
			`(${outcome.error?.message}). Stop whatever is holding them, or pass --port to pick another.\n`,
	);
	process.exit(1);
}

if (outcome.adopted) {
	process.stderr.write(
		`cursor-subscription: a shim is already serving ${shim.host}:${shim.port}; this process will not ` +
			"serve it. Stop that one first if you meant to replace it.\n",
	);
	process.exit(1);
}

const status = await store.status();
if (shim.movedPort) {
	process.stderr.write(
		`cursor-subscription: port ${shim.preferredPort} was already taken, so the shim moved to ` +
			`${shim.port}. Use the base URL below, not the one you asked for.\n`,
	);
}
const config = shim.configuration();
process.stderr.write(
	`cursor-subscription: shim listening on http://${shim.host}:${shim.port}/v1\n` +
		`cursor-subscription: credentials at ${dataDir()}\n` +
		`cursor-subscription: ${status.authenticated ? "signed in" : "not signed in — run cursor_login"}\n` +
		// Printed because a live run's behaviour is uninterpretable without knowing
		// which path it took.
		`cursor-subscription: history=${config.turnsInState ? "turns-in-state" : config.structuredHistory ? "structured" : "text-transcript"} ` +
		`client=${CURSOR_CLIENT_VERSION}\n`,
);

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		shim.close().finally(() => process.exit(0));
	});
}
