#!/usr/bin/env node
/**
 * Sad-path and edge-case probes against the running shim.
 *
 * These spend no model quota — every one of them is malformed input the shim
 * must survive, or a local-only property it must hold. The live round trip in
 * `live-roundtrip.mjs` proves the happy path; this proves the shim does not
 * wedge, hang, leak, or lie when things are wrong.
 *
 * Every probe is bounded. A check that can hang is not a check.
 *
 *   node test/sad-paths.mjs
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DATA =
	process.env.CURSOR_SUBSCRIPTION_DATA ??
	join(process.env.HOME, ".zcode/cli/plugins/data/cursor-subscription@dev-zcode-cursor-b9b95b48");
const KEY = process.env.CURSOR_SHIM_KEY ?? (await readFile(join(DATA, "shim-key"), "utf8")).trim();
const PORT = process.env.CURSOR_SHIM_PORT ?? "8477";
const ORIGIN = `http://127.0.0.1:${PORT}`;
const MODEL = process.env.CURSOR_PROBE_MODEL ?? "composer-2.5-fast";
const TIMEOUT = 60_000;

let failures = 0;
const check = (name, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures += 1;
};

async function post(body, { key = KEY, headers = {}, timeout = TIMEOUT } = {}) {
	const response = await fetch(`${ORIGIN}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
		signal: AbortSignal.timeout(timeout),
	});
	const text = await response.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}
	return { status: response.status, text, json };
}

const chat = (messages, extra = {}) => ({ model: MODEL, stream: false, max_tokens: 64, messages, ...extra });

console.log(`\n=== auth and routing ===`);

{
	const r = await post(chat([{ role: "user", content: "hi" }]), { key: "wrong" });
	check("wrong key is rejected with 401", r.status === 401, `got ${r.status}`);
}
{
	const r = await fetch(`${ORIGIN}/health`, { headers: { authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(5_000) });
	const body = await r.json();
	check("health identifies the service", body.service === "cursor-subscription-shim", `service=${body.service}`);
}
{
	const r = await post(chat([{ role: "user", content: "hi" }]));
	check("every SSE-less completion carries a finish_reason", typeof r.json?.choices?.[0]?.finish_reason === "string", `got ${r.json?.choices?.[0]?.finish_reason}`);
	check("usage is present even when Cursor reports nothing", r.json?.usage !== undefined, JSON.stringify(r.json?.usage));
}

console.log(`\n=== malformed input must not wedge the shim ===`);

/** [name, body, expectedStatus] — 4xx means the fault was attributed correctly. */
const malformed = [
	["not JSON at all", "{ this is not json", 400],
	["a JSON array instead of an object", "[1,2,3]", 400],
	["empty body", "", 400],
	["missing messages", { model: MODEL, stream: false }, 400],
	["messages is a string", { model: MODEL, messages: "hello", stream: false }, 400],
	["messages is empty", chat([]), 400],
	["unknown model id", chat([{ role: "user", content: "hi" }], { model: "no-such-model-xyz" })],
	["content is a number", { model: MODEL, messages: [{ role: "user", content: 42 }], stream: false }],
	["tools is not an array", chat([{ role: "user", content: "hi" }], { tools: { nope: true } })],
	["tool missing a function", chat([{ role: "user", content: "hi" }], { tools: [{ type: "function" }] })],
	["tool parameters is garbage", chat([{ role: "user", content: "hi" }], { tools: [{ type: "function", function: { name: "t", parameters: "nope" } }] })],
	["stream true with an empty tools array", chat([{ role: "user", content: "hi" }], { stream: true, tools: [] })],
	["absurd max_tokens", chat([{ role: "user", content: "hi" }], { max_tokens: 10_000_000 })],
];

for (const [name, body, expected] of malformed) {
	let result;
	try {
		result = await post(body, { timeout: 45_000 });
	} catch (error) {
		check(name, false, `threw or hung: ${error.message}`);
		continue;
	}
	const isJsonError = result.json?.error !== undefined;
	// A caller mistake must be a 4xx. Reporting it as a 5xx sends the host
	// hunting a server bug that does not exist.
	const statusOk = expected === undefined ? result.status < 500 : result.status === expected;
	check(
		name,
		statusOk,
		`HTTP ${result.status}${isJsonError ? ` ${result.json.error.code ?? ""}` : ""}${statusOk ? "" : ` (expected ${expected ?? "<500"})`}`,
	);
}

console.log(`\n=== the shim is still healthy after all of that ===`);
{
	let ok = false;
	let detail = "";
	try {
		const r = await fetch(`${ORIGIN}/health`, { headers: { authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(5_000) });
		ok = r.status === 200;
		detail = `HTTP ${r.status}`;
	} catch (error) {
		detail = error.message;
	}
	check("health still answers", ok, detail);
}
{
	const r = await post(chat([{ role: "user", content: "Reply with the single word: PONG" }]));
	check("a real completion still works afterwards", r.json?.choices?.[0]?.message?.content?.includes("PONG"), (r.json?.choices?.[0]?.message?.content ?? "").slice(0, 40));
}

console.log(`\n${failures === 0 ? "PASS — no sad path wedged the shim" : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
