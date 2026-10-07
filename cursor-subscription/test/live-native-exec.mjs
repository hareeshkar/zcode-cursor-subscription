#!/usr/bin/env node
/**
 * Live translation probe: does a Cursor model's NATIVE built-in exec become a
 * host tool call that survives the host's inputSchema validation?
 *
 * Not a unit test — this spends real quota. It exists because translation
 * failed silently in the field: the model called its own read tool, the shim
 * renamed nothing, the host stripped the unknown `path` key and rejected the
 * call with "required parameter `file_path` is missing" on every retry. The
 * model saw the error, retried, and got the same broken shape back — four
 * failed Reads in one turn while the Bash translation (whose names happen to
 * match) worked in the same conversation.
 *
 * Distinct from live-roundtrip.mjs, which declares a synthetic `read_file`
 * tool and so exercises the mcp_args path only. This probe declares ZCode's
 * REAL tool schemas and lets the model pick its native mechanism, then asserts
 * the host-shaped result — whatever channel it arrived by. The shim's
 * `translated` counters (visible at /internal/status) say which path served it.
 *
 *   node test/live-native-exec.mjs [model ...]
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

if (process.env.CURSOR_LIVE_TESTS !== "1") {
	console.error("This probe spends real Cursor quota. Re-run with CURSOR_LIVE_TESTS=1 to allow it.");
	process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const DATA =
	process.env.CURSOR_SUBSCRIPTION_DATA ??
	join(process.env.HOME, ".zcode/cli/plugins/data/cursor-subscription@dev-zcode-cursor-b9b95b48");
const KEY = process.env.CURSOR_SHIM_KEY ?? (await readFile(join(DATA, "shim-key"), "utf8")).trim();
const PORT = process.env.CURSOR_SHIM_PORT ?? "8477";
const BASE = `http://127.0.0.1:${PORT}`;

const TARGET = join(here, "live-native-exec.mjs");
// Exists only in this file's body, so the answer cannot come from weights.
const CANARY = "merlin-3c8d-77e1";

const DEFAULT_MODELS = ["grok-4.7-high-fast", "gpt-5.6-luna-medium-fast"];
const MODELS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_MODELS;

// ZCode's REAL declared schemas (contracts/src/tools/*.ts). A probe with an
// invented schema would pass while the real host rejects the call — that is
// exactly how the bug survived its own test suite.
const TOOLS = [
	{ type: "function", function: { name: "Bash", description: "Execute a bash command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
	{ type: "function", function: { name: "Read", description: "Read a file from the local filesystem.", parameters: { type: "object", properties: { file_path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["file_path"] } } },
	{ type: "function", function: { name: "Grep", description: "Search file contents with a regex.", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" } }, required: ["pattern"] } } },
];

const SYSTEM = "You are a coding agent working on a real repository. Use the tools you have.";
const ASK = `Read the file at ${TARGET}. Do not guess its contents — actually read the file.`;

async function ask(model, messages, label) {
	process.stdout.write(`  ....  ${label}\n`);
	const started = Date.now();
	let response;
	try {
		response = await fetch(`${BASE}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
			body: JSON.stringify({ model, stream: false, max_tokens: 900, messages, tools: TOOLS }),
			signal: AbortSignal.timeout(180_000),
		});
	} catch (error) {
		throw new Error(
			`${label}: ${error.name === "TimeoutError" ? "no answer in 180s" : error.message}`,
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

async function statusCounters() {
	try {
		const r = await fetch(`${BASE}/internal/status`, { headers: { authorization: `Bearer ${KEY}` } });
		const s = await r.json();
		return { translated: s.translated ?? {}, toolCalls: s.toolCalls ?? 0, dropped: s.droppedToolCalls ?? 0 };
	} catch {
		return { translated: {}, toolCalls: 0, dropped: 0 };
	}
}

let failures = 0;
for (const model of MODELS) {
	process.stdout.write(`\n=== ${model} ===\n`);
	const before = await statusCounters();
	try {
		const first = await ask(model, [
			{ role: "system", content: SYSTEM },
			{ role: "user", content: ASK },
		], "turn 1 (expect a Read tool call)");

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

		// The assertion this probe exists for. ZCode's Read requires file_path;
		// a `path` key means the translation (or the model) used the wrong name
		// and the host will reject the call — the field failure, not a guess.
		if (call.function.name !== "Read" || typeof args.file_path !== "string" || args.file_path.length === 0) {
			console.log(`  FAIL  not a host-shaped Read: ${call.function.name} ${JSON.stringify(args)}`);
			failures += 1;
			continue;
		}
		if ("path" in args) {
			console.log(`  FAIL  arguments carry the old \`path\` key alongside file_path`);
			failures += 1;
			continue;
		}
		console.log(`  ok    host-shaped: file_path present, no legacy path key`);

		// Execute exactly as the host would, then verify the model can use it.
		const contents = await readFile(args.file_path, "utf8");
		console.log(`  ok    executed; read ${contents.length} bytes`);

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

		const after = await statusCounters();
		const translatedDelta = {};
		for (const [k, v] of Object.entries(after.translated)) {
			const d = v - (before.translated[k] ?? 0);
			if (d > 0) translatedDelta[k] = d;
		}
		const dropped = after.dropped - before.dropped;
		console.log(
			`  info  served via: ${Object.keys(translatedDelta).length > 0
				? `translated native exec ${JSON.stringify(translatedDelta)}`
				: "declared-tool mcp_args (no native exec this run)"}, droppedToolCalls delta=${dropped}`,
		);
		if (dropped > 0) {
			console.log(`  FAIL  tool calls were dropped (${dropped}) — the counter caught a silent loss`);
			failures += 1;
		}
	} catch (error) {
		console.log(`  FAIL  ${error.message}`);
		failures += 1;
	}
}

console.log(`\n${failures === 0 ? "PASS — native execs became host-shaped tool calls" : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
