#!/usr/bin/env node
/**
 * Live agent-behaviour probes: the parts a single tool call cannot show.
 *
 * `live-roundtrip.mjs` proves one tool call works. This proves the things that
 * only break over a conversation — the model picking the *right* tool, using
 * the contract after several turns, following a system prompt that was set
 * once, and adapting when the user steers mid-session.
 *
 * Every request is bounded and timed, and the phase is printed before the wait,
 * so a stall is reported as a stall.
 *
 *   node test/live-conversation.mjs [model]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// These spend real quota against a real account. Refuse to start unless the
// caller opted in, so a stray `node --test test/*.mjs` cannot spend the user's
// credits or surprise them with a slow suite.
if (process.env.CURSOR_LIVE_TESTS !== "1") {
	console.error("This probe spends real Cursor quota. Re-run with CURSOR_LIVE_TESTS=1 to allow it.");
	process.exit(2);
}


const DATA =
	process.env.CURSOR_SUBSCRIPTION_DATA ??
	join(process.env.HOME, ".zcode/cli/plugins/data/cursor-subscription@dev-zcode-cursor-b9b95b48");
const KEY = process.env.CURSOR_SHIM_KEY ?? (await readFile(join(DATA, "shim-key"), "utf8")).trim();
const BASE = `http://127.0.0.1:${process.env.CURSOR_SHIM_PORT ?? "8477"}/v1`;
const MODEL = process.argv[2] ?? "composer-2.5-fast";
const TIMEOUT = 90_000;

const TOOLS = [
	{
		type: "function",
		function: {
			name: "get_weather",
			description: "Get the current weather for a city.",
			parameters: {
				type: "object",
				properties: { city: { type: "string", description: "City name." } },
				required: ["city"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "convert_currency",
			description: "Convert an amount of money between two currencies.",
			parameters: {
				type: "object",
				properties: {
					amount: { type: "number" },
					from: { type: "string" },
					to: { type: "string" },
				},
				required: ["amount", "from", "to"],
			},
		},
	},
];

let failures = 0;
const check = (name, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures += 1;
};

async function ask(messages, label) {
	process.stdout.write(`  ....  ${label}\n`);
	const started = Date.now();
	const response = await fetch(`${BASE}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
		body: JSON.stringify({ model: MODEL, stream: false, max_tokens: 700, messages, tools: TOOLS }),
		signal: AbortSignal.timeout(TIMEOUT),
	});
	const body = await response.json();
	if (body.error) throw new Error(`${label}: ${JSON.stringify(body.error)}`);
	process.stdout.write(`  ....  ${label} answered in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
	return body.choices?.[0];
}

const exec = (choice) => {
	const call = choice?.message?.tool_calls?.[0];
	if (!call) return null;
	return { call, args: JSON.parse(call.function.arguments) };
};

console.log(`\n=== ${MODEL} ===`);

try {
	// 1. Tool selection. Two contracts offered; only one applies. A model that
	//    calls the wrong one is a contract-delivery failure, not a model failure.
	const weather = exec(
		await ask(
			[
				{ role: "system", content: "You are a helpful assistant with tools." },
				{ role: "user", content: "What is the weather in Oslo? Use the right tool." },
			],
			"tool selection",
		),
	);
	check("picks the tool the request implies", weather?.call.function.name === "get_weather", `called ${weather?.call.function.name ?? "nothing"}`);
	check("passes the argument the schema requires", weather?.args?.city?.toLowerCase() === "oslo", JSON.stringify(weather?.args));

	// 2. Contract retention + steering. The user changes their mind mid-session
	//    and the system prompt set at the start must still be in force.
	const messages = [
		{ role: "system", content: "You are a terse assistant. Answer in at most one short sentence." },
		{ role: "user", content: "What is the weather in Oslo?" },
		{ role: "assistant", content: null, tool_calls: [weather.call] },
		{ role: "tool", tool_call_id: weather.call.id, content: JSON.stringify({ tempC: 3, sky: "overcast" }) },
		{ role: "user", content: "Actually, forget Oslo — check the weather in Bergen instead. Use the tool." },
	];

	const steered = exec(await ask(messages, "steering mid-session"));
	check("follows the steering, not the original ask", steered?.call.function.name === "get_weather", `called ${steered?.call.function.name ?? "nothing"}`);
	check("uses the new city, not the old one", /bergen/i.test(steered?.args?.city ?? ""), JSON.stringify(steered?.args));

	// 3. System-prompt retention after the tool round.
	messages.push(
		{ role: "assistant", content: null, tool_calls: [steered.call] },
		{ role: "tool", tool_call_id: steered.call.id, content: JSON.stringify({ tempC: 7, sky: "rain" }) },
		{ role: "user", content: "What is the weather like there?" },
	);
	const final = await ask(messages, "system prompt still in force after tool turns");
	const reply = final?.message?.content ?? "";
	check("answers from the tool result", /\brain|7/i.test(reply), reply.slice(0, 100));
	const sentences = reply.split(/[.!?]+\s/).filter((x) => x.trim().length > 0).length;
	check("honours the one-sentence system prompt", sentences <= 1, `${sentences} sentences: ${reply.slice(0, 80)}`);
} catch (error) {
	console.log(`  FAIL  ${error.message}`);
	failures += 1;
}

console.log(`\n${failures === 0 ? "PASS — the model behaves like an agent across turns" : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
