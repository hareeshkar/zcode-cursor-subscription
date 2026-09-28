#!/usr/bin/env node
/**
 * Native-history regression matrix.
 *
 * Proves, per shape, that prior turns sent as native ConversationHistoryMessage
 * objects in UserMessageAction.conversation_history actually reach the model's
 * context — measured by recall of a value that exists nowhere else.
 *
 * Spends real quota. Gated behind CURSOR_LIVE_TESTS=1, and requires the shim to
 * be started with CURSOR_STRUCTURED_HISTORY=1 for the native rows (the startup
 * line prints the mode, so a result is attributable to a path).
 *
 *   CURSOR_LIVE_TESTS=1 node test/live-structured.mjs [baseUrl]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

if (process.env.CURSOR_LIVE_TESTS !== "1") {
	console.error("This probe spends real Cursor quota. Re-run with CURSOR_LIVE_TESTS=1 to allow it.");
	process.exit(2);
}

const DATA =
	process.env.CURSOR_SUBSCRIPTION_DATA ??
	join(process.env.HOME, ".zcode/cli/plugins/data/cursor-subscription@dev-zcode-cursor-b9b95b48");
const KEY = process.env.CURSOR_SHIM_KEY ?? (await readFile(join(DATA, "shim-key"), "utf8")).trim();
const BASE = process.argv[2] ?? `http://127.0.0.1:${process.env.CURSOR_SHIM_PORT ?? "8477"}`;

const NAME = "Alice";
const PORT = "8080";

const TOOLS = [
	{
		type: "function",
		function: {
			name: "read_file",
			description: "Read a file from the local filesystem.",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
	},
];

/** Each case: history before the action, the action, the token that proves recall. */
const CASES = [
	{
		name: "no-history",
		messages: [
			{
				role: "user",
				content: "What is my name? If you were not told, reply with the single word UNKNOWN.",
			},
		],
		expect: null,
		why: "control — with no prior turns the model cannot know the name. Phrased so the model answers directly instead of trying to search, which without tools makes the run loop on refusals and time out.",
	},
	{
		name: "pair",
		messages: [
			{ role: "user", content: "My name is Alice." },
			{ role: "assistant", content: "Nice to meet you, Alice." },
			{ role: "user", content: "What is my name? Answer with just the name." },
		],
		expect: NAME,
		why: "a user/assistant pair must reach the model's context",
	},
	{
		name: "tool-chain",
		messages: [
			{ role: "user", content: "Check the deployment configuration." },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"/srv/deploy.sh"}' } },
				],
			},
			{ role: "tool", tool_call_id: "call_1", tool_name: "read_file", content: "PORT=8080\nRETRIES=3" },
			{ role: "user", content: "What port is the application running on? Answer with just the number." },
		],
		expect: PORT,
		tools: TOOLS,
		why: "the original information-loss bug: a tool call and its result must survive replay",
	},
	{
		name: "full-chain",
		messages: [
			{ role: "user", content: "My name is Alice." },
			{ role: "assistant", content: "Nice to meet you, Alice." },
			{ role: "user", content: "Check the deployment configuration." },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{ id: "call_2", type: "function", function: { name: "read_file", arguments: '{"path":"/srv/deploy.sh"}' } },
				],
			},
			{ role: "tool", tool_call_id: "call_2", tool_name: "read_file", content: "PORT=8080\nRETRIES=3" },
			{ role: "user", content: "What is my name, and what port is the app on? Answer as 'name port'." },
		],
		expect: `${NAME} ${PORT}`,
		tools: TOOLS,
		why: "both a pair and a tool round must survive together",
	},
];

let failures = 0;
for (const c of CASES) {
	process.stdout.write(`\n=== ${c.name} ===\n  ${c.why}\n`);
	const started = Date.now();
	try {
		const res = await fetch(`${BASE}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
			body: JSON.stringify({
				model: process.env.CURSOR_PROBE_MODEL ?? "composer-2.5-fast",
				stream: false,
				max_tokens: 60,
				messages: c.messages,
				tools: c.tools,
			}),
			signal: AbortSignal.timeout(120_000),
		});
		const body = await res.json();
		if (body.error) throw new Error(JSON.stringify(body.error).slice(0, 140));
		const reply = (body.choices?.[0]?.message?.content ?? "").trim();
		const secs = ((Date.now() - started) / 1000).toFixed(1);
		if (c.expect === null) {
			const knew = reply.toLowerCase().includes(NAME.toLowerCase());
			console.log(`  ${secs}s  reply=${JSON.stringify(reply.slice(0, 70))}`);
			console.log(`  ${knew ? "FAIL" : "ok  "}  the model does not know the name (control)`);
			if (knew) failures += 1;
		} else {
			const hit = reply.toLowerCase().includes(c.expect.toLowerCase());
			console.log(`  ${secs}s  reply=${JSON.stringify(reply.slice(0, 70))}`);
			console.log(`  ${hit ? "ok  " : "FAIL"}  recalled ${c.expect}`);
			if (!hit) failures += 1;
		}
	} catch (error) {
		console.log(`  FAIL  ${error.message}`);
		failures += 1;
	}
}

// Mode-neutral: this script proves whichever replay path the shim was started in.
console.log(`\n${failures === 0 ? "PASS — history reaches the model's context on this path" : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
