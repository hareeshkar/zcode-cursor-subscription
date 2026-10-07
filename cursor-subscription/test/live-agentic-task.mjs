#!/usr/bin/env node
/**
 * Live agentic workload: five model families, five real tasks, one project.
 *
 * Not a unit test — real quota, real file edits. The point is the whole
 * product working as the user experiences it: a Cursor model receives a web
 * development task, drives whatever tool mechanism it prefers (its own native
 * execs — translated — or the host tools declared to it), and the work lands
 * on disk. Tasks are deliberately subagent-shaped: dispatching helpers,
 * collecting their reports, and managing context across them — which is what
 * exercises the subagentArgs→Agent and subagentAwait→TaskOutput translations.
 *
 * Model policy: plain MEDIUM variants only — no -fast, no high/xhigh — and
 * every task is verified from the files afterwards. The shim's per-exec
 * `translated` counters say which mechanism actually served every tool call.
 *
 *   node test/live-agentic-task.mjs [model ...]   # default: all five tasks
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join, resolve, relative, dirname } from "node:path";

const exec = promisify(execFile);

if (process.env.CURSOR_LIVE_TESTS !== "1") {
	console.error("This probe spends real Cursor quota. Re-run with CURSOR_LIVE_TESTS=1 to allow it.");
	process.exit(2);
}

const PROJECT_DIR = resolve(process.env.PROJECT_DIR ?? join(homedir(), "Desktop/agentic-web-test"));
const DATA =
	process.env.CURSOR_SUBSCRIPTION_DATA ??
	join(process.env.HOME, ".zcode/cli/plugins/data/cursor-subscription@dev-zcode-cursor-b9b95b48");
const KEY = process.env.CURSOR_SHIM_KEY ?? (await readFile(join(DATA, "shim-key"), "utf8")).trim();
const BASE = `http://127.0.0.1:${process.env.CURSOR_SHIM_PORT ?? "8477"}`;

const MAX_ROUNDS = 16;
const SUB_MAX_ROUNDS = 5;
const MAX_TOKENS = 8000;

// ZCode's REAL tool schemas, including the two that make subagent work real:
// Agent (dispatch) and TaskOutput (await/poll).
const TOOLS = [
	{ type: "function", function: { name: "Read", description: "Read a file from the local filesystem.", parameters: { type: "object", properties: { file_path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["file_path"] } } },
	{ type: "function", function: { name: "Write", description: "Write a file to the local filesystem.", parameters: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } } },
	{ type: "function", function: { name: "Edit", description: "Replace an exact string in a file.", parameters: { type: "object", properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["file_path", "old_string", "new_string"] } } },
	{ type: "function", function: { name: "Bash", description: "Execute a shell command in the project directory.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
	{ type: "function", function: { name: "Glob", description: "List files matching a glob pattern (* and ** cross directories, {a,b} alternates).", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } } },
	{ type: "function", function: { name: "Grep", description: "Search file contents with a regex.", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" } }, required: ["pattern"] } } },
	{ type: "function", function: { name: "Agent", description: "Dispatch a subagent that runs with its own context and read-only tools (Read, Grep, Glob). Provide a complete, self-contained task.", parameters: { type: "object", properties: { description: { type: "string" }, prompt: { type: "string" }, subagent_type: { type: "string" }, run_in_background: { type: "boolean" } }, required: ["description", "prompt"] } } },
	{ type: "function", function: { name: "TaskOutput", description: "Get the output of a previously dispatched subagent by task id.", parameters: { type: "object", properties: { task_id: { type: "string" }, block: { type: "boolean" }, timeout: { type: "number" } }, required: ["task_id", "block", "timeout"] } } },
];

const SUB_TOOLS = TOOLS.filter((t) => ["Read", "Grep", "Glob"].includes(t.function.name));

const SYSTEM = `You are a web developer agent working on a real project at ${PROJECT_DIR}. Use the tools to inspect and change files — never guess contents. Keep edits minimal and consistent with the existing code. All files live under this project root; address them by absolute path starting with it. Subagents run read-only: use them to gather facts, then make the edits yourself. When the task is complete, reply with a single line starting with "DONE:" followed by a one-line summary.`;

const SUBAGENT_SYSTEM =
	"You are a focused read-only analyst subagent. Use Read/Grep/Glob to investigate exactly what you were asked, then reply with your findings as concise bullet points. Reply only with the findings.";

const TASKS = [
	{
		model: "grok-4.7-medium",
		label: "GROK — persistence + a11y feature",
		prompt:
			"Implement a persistence and accessibility feature. Step 1: dispatch ONE subagent NOW to inventory every interactive element in /Users/hareeshkarravi/Desktop/agentic-web-test/index.html and /Users/hareeshkarravi/Desktop/agentic-web-test/app.js — ids, event listeners, localStorage keys, and which elements lack accessible names. Step 2: from the inventory alone, implement in app.js: persist the theme under localStorage key \"pb.theme.v2\" with migration from the old \"pb-theme\" key, and default to prefers-color-scheme when no stored choice exists. Step 3: add aria-labels to every unnamed interactive element the inventory found. Step 4: run node --check app.js, then write FEATURE.md (what changed, migration notes, which inventory items you addressed). Reply DONE: when finished.",
		verify: async () => {
			const js = await readFile(join(PROJECT_DIR, "app.js"), "utf8");
			const migrated = js.includes("pb.theme.v2") && js.includes("pb-theme");
			const a11y = /aria-label/.test(await readFile(join(PROJECT_DIR, "index.html"), "utf8")) || /aria-label/.test(js);
			const media = /prefers-color-scheme/.test(js);
			let doc = false, syntax = true;
			try { doc = (await readFile(join(PROJECT_DIR, "FEATURE.md"), "utf8")).length > 100; } catch {}
			try { await exec("/usr/bin/env", ["node", "--check", join(PROJECT_DIR, "app.js")]); } catch { syntax = false; }
			return { ok: migrated && media && a11y && doc && syntax, detail: `migration=${migrated}, prefers-color-scheme=${media}, aria=${a11y}, FEATURE.md=${doc}, syntax=${syntax}` };
		},
	},
	{
		model: "gpt-5.6-luna-medium",
		label: "LUNA — i18n extraction pipeline",
		prompt:
			"Build an i18n extraction pipeline. Step 1: dispatch a subagent NOW to extract every user-visible string from /Users/hareeshkarravi/Desktop/agentic-web-test/index.html as a numbered list with line numbers (headline, subtext, buttons, card titles and bodies, form, footer). Step 2: create locales/en.json mapping snake_case keys to the English strings, and locales/es.json with Spanish translations of the same keys. Step 3: add a data-i18n attribute with its key to each of those elements in index.html (keep the English text as content). Step 4: write I18N.md documenting the key map and how to add a language. Reply DONE: when finished.",
		verify: async () => {
			const results = [];
			try {
				const en = JSON.parse(await readFile(join(PROJECT_DIR, "locales/en.json"), "utf8"));
				const es = JSON.parse(await readFile(join(PROJECT_DIR, "locales/es.json"), "utf8"));
				results.push(Object.keys(en).length >= 10 && JSON.stringify(Object.keys(en).sort()) === JSON.stringify(Object.keys(es).sort()));
			} catch { results.push(false); }
			const html = await readFile(join(PROJECT_DIR, "index.html"), "utf8");
			results.push((html.match(/data-i18n=/g) ?? []).length >= 8);
			try { results.push((await readFile(join(PROJECT_DIR, "I18N.md"), "utf8")).length > 80); } catch { results.push(false); }
			return { ok: results.every(Boolean), detail: `locales aligned=${results[0]}, data-i18n tags=${(html.match(/data-i18n=/g) ?? []).length}, I18N.md=${results[2]}` };
		},
	},
	{
		model: "claude-haiku-5-5-medium",
		label: "HAIKU — module split with review",
		prompt:
			"Split /Users/hareeshkarravi/Desktop/agentic-web-test/app.js into ES modules with zero behavior change. Step 1: create js/theme.js (theme toggle + persistence), js/validate.js (email validation), js/ui.js (badge/pill/dot factories and feature badges), and app.js as the barrel that wires DOMContentLoaded and re-exports window.PulseBoard with the same three members. Step 2: update index.html to load the modules (script type=\"module\" is fine). Step 3: run node --check on every file. Step 4: dispatch a subagent to review the split for behavior differences (listeners, ids, export names) and report; fix anything real. Step 5: write REFACTOR.md (module map + the reviewer's findings). Reply DONE: when finished.",
		verify: async () => {
			const results = [];
			for (const f of ["js/theme.js", "js/validate.js", "js/ui.js", "app.js"]) {
				try { await exec("/usr/bin/env", ["node", "--check", join(PROJECT_DIR, f)]); results.push(true); }
				catch { results.push(false); }
			}
			const barrel = await readFile(join(PROJECT_DIR, "app.js"), "utf8");
			results.push(barrel.includes("PulseBoard"));
			try { results.push((await readFile(join(PROJECT_DIR, "REFACTOR.md"), "utf8")).length > 80); } catch { results.push(false); }
			return { ok: results.every(Boolean), detail: `4 files syntax-valid=${results.slice(0, 4).every(Boolean)}, barrel export=${results[4]}, REFACTOR.md=${results[5]}` };
		},
	},
	{
		model: "gemini-3.8-flash-medium",
		label: "GEMINI — design-token system + responsive",
		prompt:
			"Introduce a design-token system and responsive layout in /Users/hareeshkarravi/Desktop/agentic-web-test/styles.css. Step 1: read styles.css and index.html once each. Step 2: replace raw values with custom-property tokens: a spacing scale (--space-1..6), a radius scale (--radius-sm/md/lg), a shadow scale (--shadow-1/2), plus the existing color tokens; use them throughout. Step 3: add responsive breakpoints — cards stack to one column under 720px, hero scales down, nav wraps. Step 4: polish dark mode with the tokens. Step 5: write DESIGN.md with a table of every token, its value and where it is used. Do not change text content or app.js. Reply DONE: when finished.",
		verify: async () => {
			const css = await readFile(join(PROJECT_DIR, "styles.css"), "utf8");
			const spacing = /--space-[1-6]/.test(css);
			const radius = /--radius-(sm|md|lg)/.test(css);
			const shadow = /--shadow-[12]/.test(css);
			const responsive = /@media[^]*720px/.test(css);
			let doc = false;
			try { doc = (await readFile(join(PROJECT_DIR, "DESIGN.md"), "utf8")).includes("--"); } catch {}
			return { ok: spacing && radius && shadow && responsive && doc, detail: `spacing=${spacing}, radius=${radius}, shadow=${shadow}, @media=${responsive}, DESIGN.md=${doc}` };
		},
	},
	{
		model: "composer-2.5",
		label: "COMPOSER — release engineering",
		prompt:
			"Release-engineer the project at /Users/hareeshkarravi/Desktop/agentic-web-test — four agents have just changed it. Step 1: read every file including any FEATURE.md, I18N.md, REFACTOR.md, DESIGN.md. Step 2: dispatch a subagent to produce a QA checklist for the app's behaviours (theme persistence + migration, email validation, i18n key/data-i18n alignment, module wiring). Step 3: write tests/smoke.mjs — a Node script (no deps) that: parses index.html and asserts every data-i18n value exists as a key in locales/en.json (skip the section gracefully if those files are absent, reporting SKIPPED), and asserts index.html references exactly the js/*.js files that exist. RUN it and include its output. Step 4: package.json with scripts dev (npx serve .), build (echo), test (node tests/smoke.mjs); README.md with ## Commands and ## Architecture sections; WORKLOG.md attributing each agent's work; .gitignore (node_modules, .DS_Store). Step 5: write REVIEW.md with your verdict, quoting the subagent's checklist. Reply DONE: when finished.",
		verify: async () => {
			const results = [];
			try {
				const pkg = JSON.parse(await readFile(join(PROJECT_DIR, "package.json"), "utf8"));
				results.push(Boolean(pkg.scripts?.dev && pkg.scripts?.test));
			} catch { results.push(false); }
			try {
				const test = await readFile(join(PROJECT_DIR, "tests/smoke.mjs"), "utf8");
				results.push(test.includes("data-i18n"));
				try {
					await exec("/usr/bin/env", ["node", join(PROJECT_DIR, "tests/smoke.mjs")]);
					results.push(true); // exit 0 = passing or gracefully skipped
				} catch { results.push(false); }
			} catch { results.push(false, false); }
			for (const f of ["README.md", "WORKLOG.md", "REVIEW.md", ".gitignore"]) {
				try { results.push((await readFile(join(PROJECT_DIR, f), "utf8")).length > 20); } catch { results.push(false); }
			}
			return { ok: results.every(Boolean), detail: `pkg=${results[0]}, smoke test exists=${results[1]}, runs clean=${results[2]}, docs+gitignore=${results.slice(3).filter(Boolean).length}/4` };
		},
	},
];

const only = process.argv.slice(2);
const tasks = only.length > 0 ? TASKS.filter((t) => only.includes(t.model)) : TASKS;

// --- a miniature host: real execution of the declared tool semantics ---

function inProject(path) {
	const abs = resolve(PROJECT_DIR, path);
	const rel = relative(PROJECT_DIR, abs);
	return rel === "" || (!rel.startsWith("..") && !resolve(rel).startsWith("/"));
}

async function walkFiles(dir, out = []) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (e.name.startsWith(".") || e.name === "node_modules") continue;
		const p = join(dir, e.name);
		if (e.isDirectory()) await walkFiles(p, out);
		else out.push(p);
	}
	return out;
}

/** Expand {a,b} alternations into every combination. */
function expandBraces(pattern) {
	const match = pattern.match(/\{([^{}]*)\}/);
	if (!match) return [pattern];
	const out = [];
	for (const alt of match[1].split(",")) {
		out.push(...expandBraces(pattern.replace(match[0], alt)));
	}
	return out;
}

function globSource(pattern) {
	let re = "";
	for (let i = 0; i < pattern.length; i += 1) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				re += ".*";
				i += 1;
			} else {
				re += "[^/]*";
			}
		} else if (ch === "?") {
			re += "[^/]";
		} else {
			re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return re;
}

function globToRegExp(pattern) {
	// `**` crosses directories, `*` does not, `{a,b}` alternates — the shapes
	// models actually emit. The first live run had none of this, told every
	// caller "(no matches)", and the models correctly retried until cut off.
	return new RegExp(`^(?:${expandBraces(String(pattern)).map(globSource).join("|")})$`);
}

/** Completed subagents, in dispatch order — the TaskOutput registry. */
const subagentLog = [];

async function runSubagent(prompt) {
	const messages = [
		{ role: "system", content: SUBAGENT_SYSTEM },
		{ role: "user", content: prompt },
	];
	for (let round = 1; round <= SUB_MAX_ROUNDS; round += 1) {
		const reply = await callModel(SUBAGENT_MODEL_FOR_ROUND, messages, SUB_TOOLS);
		if (reply.error) return `(subagent error: ${JSON.stringify(reply.error).slice(0, 200)})`;
		const message = reply.choices?.[0]?.message;
		const calls = message?.tool_calls ?? [];
		if (calls.length === 0) return (message?.content ?? "").trim() || "(subagent returned nothing)";
		messages.push({ role: "assistant", content: message?.content ?? null, tool_calls: calls });
		for (const call of calls) {
			const result = await executeTool("readonly:" + call.function.name, JSON.parse(call.function.arguments || "{}"));
			messages.push({ role: "tool", tool_call_id: call.id, content: String(result) });
		}
	}
	return "(subagent did not finish within its round budget)";
}

// Subagents run on the cheapest proven transport family, independently of the
// orchestrating model.
const SUBAGENT_MODEL_FOR_ROUND = "grok-4.7-medium";

const REQUIRED = {
	Read: ["file_path"],
	Write: ["file_path", "content"],
	Edit: ["file_path", "old_string", "new_string"],
	Bash: ["command"],
	Glob: ["pattern"],
	Grep: ["pattern"],
	Agent: ["description", "prompt"],
	TaskOutput: ["task_id", "block", "timeout"],
};

function validateInput(tool, args) {
	const missing = (REQUIRED[tool] ?? []).filter((k) => args?.[k] === undefined || args?.[k] === null || args?.[k] === "");
	if (missing.length === 0) return undefined;
	return (
		`<tool_use_error>InputValidationError: ${tool} failed due to the following issue:\n` +
		missing.map((m) => `The required parameter \`${m}\` is missing`).join("\n") +
		`</tool_use_error>`
	);
}

async function executeTool(name, args) {
	const readonly = name.startsWith("readonly:");
	const tool = readonly ? name.slice("readonly:".length) : name;
	const invalid = validateInput(tool, args ?? {});
	if (invalid) return invalid;
	try {
		if (tool === "Read") {
			const raw = await readFile(resolve(PROJECT_DIR, args.file_path), "utf8");
			const lines = raw.split("\n");
			const offset = Math.max(1, Number(args.offset ?? 1));
			const limit = Number(args.limit ?? 2000);
			const slice = lines.slice(offset - 1, offset - 1 + limit);
			if (slice.length === 0) return "(empty range)";
			return slice.map((l, i) => `${offset + i}\t${l}`).join("\n");
		}
		if (tool === "Write") {
			if (readonly) return "Error: subagents are read-only.";
			if (!inProject(args.file_path)) return "Error: writes are limited to the project directory.";
			const target = resolve(PROJECT_DIR, args.file_path);
			const { mkdir } = await import("node:fs/promises");
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, args.content ?? "");
			return `wrote ${args.content?.length ?? 0} bytes to ${args.file_path}`;
		}
		if (tool === "Edit") {
			if (readonly) return "Error: subagents are read-only.";
			if (!inProject(args.file_path)) return "Error: edits are limited to the project directory.";
			const target = resolve(PROJECT_DIR, args.file_path);
			const raw = await readFile(target, "utf8");
			const from = args.old_string ?? "";
			if (!raw.includes(from)) return `Error: old_string not found in ${args.file_path}`;
			const next = args.replace_all ? raw.split(from).join(args.new_string ?? "") : raw.replace(from, args.new_string ?? "");
			await writeFile(target, next);
			return `edited ${args.file_path}`;
		}
		if (tool === "Bash") {
			if (readonly) return "Error: subagents are read-only.";
			const { stdout, stderr } = await exec("/bin/zsh", ["-lc", String(args.command ?? "")], {
				cwd: PROJECT_DIR,
				timeout: 30_000,
				maxBuffer: 4 * 1024 * 1024,
			});
			const out = `${stdout ?? ""}${stderr ? `\n(stderr) ${stderr}` : ""}`.trim();
			return out === "" ? "(no output)" : (out.length > 4000 ? `${out.slice(0, 4000)}\n…(output truncated)` : out);
		}
		if (tool === "Glob") {
			const base = args.path ? resolve(PROJECT_DIR, args.path) : PROJECT_DIR;
			const re = globToRegExp(args.pattern ?? "*");
			const files = (await walkFiles(base)).map((p) => relative(base, p)).filter((p) => re.test(p)).slice(0, 100);
			return files.length > 0 ? files.join("\n") : "(no matches)";
		}
		if (tool === "Grep") {
			const base = args.path ? resolve(PROJECT_DIR, args.path) : PROJECT_DIR;
			const re = new RegExp(args.pattern ?? "", "m");
			const files = (await walkFiles(base)).slice(0, 400);
			const hits = [];
			for (const f of files) {
				if (args.glob && !globToRegExp(args.glob).test(relative(base, f))) continue;
				let text;
				try {
					text = await readFile(f, "utf8");
				} catch {
					continue;
				}
				if (re.test(text)) hits.push(relative(base, f));
				if (hits.length >= 50) break;
			}
			return hits.length > 0 ? hits.join("\n") : "(no matches)";
		}
		if (tool === "Agent") {
			const entry = {
				task_id: `sub_${subagentLog.length + 1}`,
				description: String(args.description ?? "subagent"),
				prompt: String(args.prompt ?? ""),
			};
			subagentLog.push(entry);
			const findings = await runSubagent(entry.prompt);
			entry.result = findings;
			return `[${entry.task_id}] ${entry.description}\n${findings}`;
		}
		if (tool === "TaskOutput") {
			const hit = subagentLog.find((s) => s.task_id === args.task_id) ?? subagentLog[subagentLog.length - 1];
			if (!hit) return "Error: no subagent has been dispatched yet.";
			return `[${hit.task_id}] ${hit.description}\n${hit.result ?? "(still running)"}`;
		}
		return `Error: unknown tool ${tool}`;
	} catch (error) {
		return `Error: ${error?.message ?? String(error)}`.slice(0, 400);
	}
}

async function callModel(model, messages, tools = TOOLS) {
	const response = await fetch(`${BASE}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
		body: JSON.stringify({ model, stream: false, max_tokens: MAX_TOKENS, messages, tools }),
		signal: AbortSignal.timeout(240_000),
	});
	const body = await response.text();
	try {
		return JSON.parse(body);
	} catch (error) {
		const bad = [...body].find((c) => c.charCodeAt(0) < 0x20 && !"\n\r\t".includes(c));
		throw new Error(`unparseable JSON (${error.message})${bad ? ` — control char 0x${bad.charCodeAt(0).toString(16)}` : ""}`);
	}
}

async function counters() {
	try {
		const r = await fetch(`${BASE}/internal/status`, { headers: { authorization: `Bearer ${KEY}` } });
		const s = await r.json();
		return {
			translated: s.translated ?? {},
			refused: s.refused ?? {},
			repeated: s.repeated ?? {},
			toolCalls: s.toolCalls ?? 0,
			dropped: s.droppedToolCalls ?? 0,
		};
	} catch {
		return { translated: {}, refused: {}, repeated: {}, toolCalls: 0, dropped: 0 };
	}
}

function delta(before, after, key) {
	const out = {};
	for (const [k, v] of Object.entries(after[key] ?? {})) {
		const d = v - (before[key]?.[k] ?? 0);
		if (d > 0) out[k] = d;
	}
	return out;
}

let failures = 0;
for (const task of tasks) {
	process.stdout.write(`\n=== ${task.label} ===\n`);
	const before = await counters();
	const messages = [
		{ role: "system", content: SYSTEM },
		{ role: "user", content: task.prompt },
	];
	const toolCounts = {};
	let lastRoundSignatures = [];
	let rounds = 0;
	let finalText = "";
	try {
		for (rounds = 1; rounds <= MAX_ROUNDS; rounds += 1) {
			process.stdout.write(`  ....  round ${rounds}\n`);
			const reply = await callModel(task.model, messages);
			if (reply.error) throw new Error(`model error: ${JSON.stringify(reply.error)}`);
			const message = reply.choices?.[0]?.message;
			const calls = message?.tool_calls ?? [];
			if (calls.length === 0) {
				const content = message?.content ?? "";
				// The shim's loop-break advisory is the SHIM speaking, not the
				// model choosing to finish: feed it back and keep the task alive,
				// exactly as a real host loop would continue past a corrective
				// assistant turn.
				if (content.startsWith("Your tool call") && rounds < MAX_ROUNDS) {
					process.stdout.write("  shim  loop-break advisory received — continuing\n");
					messages.push({ role: "assistant", content });
					messages.push({ role: "user", content: "Follow the instruction above: continue the task from the result you already have, or change your approach. Do not repeat the identical call." });
					continue;
				}
				finalText = content;
				break;
			}
			messages.push({
				role: "assistant",
				content: message?.content ?? null,
				tool_calls: calls.map((c) => ({
					id: c.id,
					type: "function",
					function: { name: c.function.name, arguments: c.function.arguments },
				})),
			});
			const signatures = new Set(lastRoundSignatures);
			lastRoundSignatures = [];
			for (const call of calls) {
				toolCounts[call.function.name] = (toolCounts[call.function.name] ?? 0) + 1;
				let args = {};
				try {
					args = JSON.parse(call.function.arguments || "{}");
				} catch {
					/* the harness returns the parse error as the tool result */
				}
				const signature = `${call.function.name}:${JSON.stringify(args)}`;
				lastRoundSignatures.push(signature);
				if (signatures.has(signature)) {
					// Loop protection, host side: the identical call ran last round
					// and its result is already in the model's history. Executing it
					// again only feeds the loop; correcting it teaches immediately.
					process.stdout.write(`  loop  ${call.function.name} repeated identically — correcting\n`);
					messages.push({
						role: "tool",
						tool_call_id: call.id,
						content:
							`<tool_use_error>This exact call was already executed in your previous turn and its result is in your history. ` +
							`Do not repeat it. Continue from that result, change the arguments meaningfully, or finish the task.</tool_use_error>`,
					});
					continue;
				}
				const result = await executeTool(call.function.name, args);
				process.stdout.write(`  tool  ${call.function.name}(${JSON.stringify(args).slice(0, 90)}) -> ${String(result).slice(0, 70).replace(/\n/g, " ")}\n`);
				messages.push({ role: "tool", tool_call_id: call.id, content: String(result) });
			}
		}
	} catch (error) {
		console.log(`  FAIL  ${error.message}`);
		failures += 1;
		continue;
	}

	const verdict = await task.verify();
	const after = await counters();
	const served = delta(before, after, "translated");
	const refusedNow = delta(before, after, "refused");
	const repeatedNow = delta(before, after, "repeated");
	const dropped = after.dropped - before.dropped;
	console.log(`  rounds=${rounds} tools=${JSON.stringify(toolCounts)} done=${finalText.slice(0, 80).replace(/\n/g, " ")}`);
	console.log(`  ${verdict.ok ? "ok  " : "FAIL"}  verify: ${verdict.detail}`);
	console.log(`  info  translated=${JSON.stringify(served)}${Object.keys(served).length === 0 ? " (all via declared tools)" : ""} refused=${JSON.stringify(refusedNow)} repeated=${JSON.stringify(repeatedNow)} dropped=+${dropped} subagents=${subagentLog.length}`);
	if (!verdict.ok || dropped > 0) failures += 1;
}

console.log(`\n${failures === 0 ? "PASS — every model completed its task and verified from the files" : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
