#!/usr/bin/env node
/**
 * Live round-trip probe: does a Cursor model actually drive a tool loop?
 *
 * Not a unit test — this spends real quota against the real account. It exists
 * because tool calling was silently broken: the model asked, the exec arrived,
 * and the turn ended as a plain `stop` with no `tool_calls`, so the host had
 * nothing to run. Every layer of the protocol encoded correctly and the feature
 * still did not work, which no amount of unit testing would have caught.
 *
 * Turn 1 asks for a real file. Turn 2 feeds the real contents back and asks a
 * question only answerable from them. A model that only appears to comply gets
 * turn 2 wrong.
 *
 *   node test/live-roundtrip.mjs [model ...]
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// These spend real quota against a real account. Refuse to start unless the
// caller opted in, so a stray `node --test test/*.mjs` cannot spend the user's
// credits or surprise them with a slow suite.
if (process.env.CURSOR_LIVE_TESTS !== "1") {
	console.error("This probe spends real Cursor quota. Re-run with CURSOR_LIVE_TESTS=1 to allow it.");
	process.exit(2);
}


const here = dirname(fileURLToPath(import.meta.url));
const DATA =
	process.env.CURSOR_SUBSCRIPTION_DATA ??
	join(process.env.HOME, ".zcode/cli/plugins/data/cursor-subscription@dev-zcode-cursor-b9b95b48");
const KEY = process.env.CURSOR_SHIM_KEY ?? (await readFile(join(DATA, "shim-key"), "utf8")).trim();
const REQUEST_TIMEOUT_MS = 180_000;
const PORT = process.env.CURSOR_SHIM_PORT ?? "8477";
const BASE = `http://127.0.0.1:${PORT}/v1`;

const TARGET = join(here, "live-roundtrip.mjs");
// A fact that exists only in this file, so turn 2 cannot be answered from the
// model's weights or from the file name.
const CANARY = "kestrel-7f2a-9d41";

const DEFAULT_MODELS = ["composer-2.5-fast", "grok-4.7-high-fast", "gpt-5.6-luna-medium-fast"];
const MODELS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_MODELS;

const SYSTEM = "You are a coding agent working on a real repository. Use the tools you have.";
const ASK = `Read the file at ${TARGET} using the read_file tool. Do not guess its contents — read it.`;

const TOOLS = [
	{
		type: "function",
		function: {
			name: "read_file",
			description: "Read a file from the local filesystem and return its contents.",
			parameters: {
				type: "object",
				properties: { path: { type: "string", description: "Absolute path of the file to read." } },
				required: ["path"],
			},
		},
	},
];



async function ask(model, messages, label) {
	// A probe that can hang tells you nothing. Every request is bounded, and the
	// phase is named, so a stall is reported as a stall rather than a mystery.
	process.stdout.write(`  ....  ${label}\n`);
	const started = Date.now();
	let response;
	try {
		response = await fetch(`${BASE}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
			body: JSON.stringify({ model, stream: false, max_tokens: 900, messages, tools: TOOLS }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		throw new Error(
			`${label}: ${error.name === "TimeoutError" ? `no answer in ${REQUEST_TIMEOUT_MS / 1000}s` : error.message}`,
		);
	}
	process.stdout.write(`  ....  ${label} answered in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
	const text = await response.text();
	try {
		return JSON.parse(text);
	} catch (error) {
		const bad = [...text].find((c) => c.charCodeAt(0) < 0x20 && !"\n\r\t".includes(c));
		throw new Error(
			`unparseable JSON (${error.message})` +
				(bad ? ` — raw control character 0x${bad.charCodeAt(0).toString(16)}` : ""),
		);
	}
}

let failures = 0;
for (const model of MODELS) {
	process.stdout.write(`\n=== ${model} ===\n`);
	try {
		// Turn 1 — must produce a tool call, not prose.
		const first = await ask(model, [
			{ role: "system", content: SYSTEM },
			{ role: "user", content: ASK },
		], "turn 1 (expect a tool call)");

		if (first.error) throw new Error(`turn 1 error: ${JSON.stringify(first.error)}`);

		const choice = first.choices?.[0];
		const call = choice?.message?.tool_calls?.[0];
		if (!call) {
			console.log(`  FAIL  no tool call (finish_reason=${choice?.finish_reason})`);
			console.log(`        text: ${(choice?.message?.content ?? "(none)").slice(0, 140)}`);
			failures += 1;
			continue;
		}
		const args = JSON.parse(call.function.arguments);
		console.log(`  ok    called ${call.function.name}(${JSON.stringify(args).slice(0, 90)})`);

		// Run the tool for real, exactly as the host would.
		const contents = await readFile(args.path ?? TARGET, "utf8");
		console.log(`  ok    executed; read ${contents.length} bytes`);

		// Turn 2 — the answer must come from the result, not the file name.
		const second = await ask(model, [
			{ role: "system", content: SYSTEM },
			{ role: "user", content: ASK },
			{ role: "assistant", content: choice.message.content ?? null, tool_calls: [call] },
			{ role: "tool", tool_call_id: call.id, content: contents },
			{ role: "user", content: "What is the CANARY value defined in that file? Answer with just the value." },
		], "turn 2 (expect the canary)");

		if (second.error) throw new Error(`turn 2 error: ${JSON.stringify(second.error)}`);

		const reply = second.choices?.[0]?.message?.content ?? "";
		const used = reply.includes(CANARY);
		console.log(`  ${used ? "ok  " : "FAIL"}  turn 2 used the result (canary ${used ? "found" : "MISSING"})`);
		if (!used) {
			console.log(`        reply: ${reply.slice(0, 200)}`);
			failures += 1;
		}
	} catch (error) {
		console.log(`  FAIL  ${error.message}`);
		failures += 1;
	}
}

console.log(`\n${failures === 0 ? "PASS — every model drove a real tool loop" : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
