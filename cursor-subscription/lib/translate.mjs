/**
 * Translation of Cursor's built-in tool execs into ZCode tool calls.
 *
 * Cursor's model natively calls its own file and shell tools (read, grep, shell
 * streams, ...). Refusing those forced the model through refusal loops; the
 * first-class behaviour is to translate each built-in into the host's registered
 * tool, so the model behaves exactly as it would in Cursor while ZCode executes
 * under its own permission system.
 *
 * Two contracts this layer must never break:
 *
 *  1. **Parameter names are the host's, not Cursor's.** Cursor's readArgs
 *     carries `path`; ZCode's Read requires `file_path`. The host strips
 *     unknown keys before validating, so a name mismatch is not a visible
 *     error here — it is a call that arrives missing its required parameter,
 *     fails `inputSchema` validation, and is regenerated identically on every
 *     retry. Live evidence: a model whose Bash translation worked (names
 *     happen to match) burned four consecutive Read attempts in one turn,
 *     each answered "The required parameter `file_path` is missing".
 *  2. **A call that cannot pass the host's validation is never emitted.**
 *     Every `required` field of the host's declared schema must be present in
 *     the built arguments, or the translation declines and the caller falls
 *     back to the typed rejection — which names the tools that do exist.
 *
 * The host schemas are read from the request's own `tools[]` when present, so
 * the mapping adapts to whatever the host declares; the alias lists below cover
 * ZCode's canonical names (`apps/zcode-cli/packages/contracts/src/tools/*.ts`).
 *
 * @module cursor-subscription/translate
 */

/** A non-empty string, or undefined so the field is simply not sent. */
function stringOf(value) {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A finite number, accepting the varint the decoder produced or a numeric
 * string — Cursor has sent both shapes for line numbers.
 */
function numberOf(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

/** A boolean, accepting the varint (0/1) the decoder produced or "true"/"false". */
function booleanOf(value) {
	if (value === 1 || value === true || value === "true") return true;
	if (value === 0 || value === false || value === "false") return false;
	return undefined;
}

/** An enum member, or undefined so a value the host does not know is not sent. */
function enumOf(value, values) {
	return typeof value === "string" && values.includes(value) ? value : undefined;
}

/** Shell-quote a value for a synthesized Bash command (git diff, ls). */
function shq(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell capability, shared by shellArgs, shellStreamArgs and
 * backgroundShellSpawnArgs. ShellArgs | 1 command | 2 working_directory |
 * 3 timeout (ms) | 11 is_background | 15 description — every one has a home
 * in ZCode's Bash; the working directory has none, so it becomes a `cd` prefix,
 * the standard technique (the git-diff translation does the same with -C).
 */
const SHELL_CAPABILITY = {
	names: ["Bash", "Shell"],
	build: (a) => {
		const command = a.fields?.[1] ?? a.primary ?? "";
		const cwd = stringOf(a.fields?.[2]);
		const timeout = numberOf(a.fields?.[3]);
		return {
			command: cwd ? `cd ${shq(cwd)} && ${command}` : command,
			timeout: timeout === undefined ? undefined : Math.min(timeout, 600_000),
			description: stringOf(a.fields?.[15]),
			run_in_background: booleanOf(a.fields?.[11]),
		};
	},
	aliases: {
		command: ["command"],
		timeout: ["timeout"],
		description: ["description"],
		run_in_background: ["run_in_background"],
	},
};

/** Sanitize Cursor's execId into a safe OpenAI tool_call id. */
function sanitizedCallId(execId) {
	// Cursor's execId joins two ids with a literal newline; a control character
	// in the OpenAI tool_call id breaks the host's pairing and rendering.
	return (
		(execId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) ||
		`call_${Math.random().toString(36).slice(2, 10)}`
	);
}

/** The read capability, shared by readArgs and its redacted variant (field 29). */
const READ_CAPABILITY = {
	// ReadArgs | 1 path | 2 tool_call_id | 4 offset | 5 limit | 6 encoding_hint
	// — offset/limit are 1-based lines on both sides, so they pass through
	// unchanged. The redacted variant shares the ReadArgs schema.
	names: ["Read"],
	build: (a) => ({
		file_path: stringOf(a.fields?.[1] ?? a.primary),
		offset: numberOf(a.fields?.[4]),
		limit: numberOf(a.fields?.[5]),
	}),
	aliases: { file_path: ["file_path", "path"], offset: ["offset"], limit: ["limit"] },
};

/**
 * Cursor exec case → host tool candidates.
 *
 * `build` produces Cursor-semantics fields; `aliases` maps each to the host's
 * parameter names, most-preferred first — the alias actually used is the first
 * one the host's declared schema knows.
 */
const CAPABILITY = {
	// ReadArgs | 1 path | 4 offset | 5 limit — offset/limit are 1-based lines
	// on both sides, so they pass through unchanged. redactedReadArgs (field 29)
	// shares the ReadArgs schema: the host is the executor either way.
	readArgs: READ_CAPABILITY,
	redactedReadArgs: READ_CAPABILITY,
	// GrepArgs | 1 pattern | 2 path | 3 glob | 4 output_mode | 5 context_before
	// | 6 context_after | 7 context | 8 case_insensitive | 9 type |
	// 10 head_limit | 11 multiline | 16 offset. ZCode's Grep spells the case
	// flag `-i`; everything else shares its name.
	grepArgs: {
		names: ["Grep"],
		build: (a) => ({
			pattern: stringOf(a.fields?.[1] ?? a.primary),
			path: stringOf(a.fields?.[2] ?? a.second),
			glob: stringOf(a.fields?.[3] ?? a.third),
			output_mode: enumOf(a.fields?.[4], ["content", "files_with_matches", "count"]),
			"-B": numberOf(a.fields?.[5]),
			"-A": numberOf(a.fields?.[6]),
			context: numberOf(a.fields?.[7]),
			"-i": booleanOf(a.fields?.[8]),
			type: stringOf(a.fields?.[9]),
			head_limit: numberOf(a.fields?.[10]),
			multiline: booleanOf(a.fields?.[11]),
			offset: numberOf(a.fields?.[16]),
		}),
		aliases: {
			pattern: ["pattern", "query"],
			path: ["path"],
			glob: ["glob", "include"],
			output_mode: ["output_mode"],
			"-B": ["-B"],
			"-A": ["-A"],
			context: ["context", "-C"],
			"-i": ["-i", "case_insensitive"],
			type: ["type"],
			head_limit: ["head_limit"],
			multiline: ["multiline"],
			offset: ["offset"],
		},
	},
	// LsArgs | 1 path. Glob is the listing tool; it needs a pattern Cursor never
	// sends, so a listing pattern is synthesized rather than the call failing.
	lsArgs: {
		names: ["Glob", "Bash"],
		build: (a, toolName) => {
			if (toolName === "Glob") return { pattern: "*", path: stringOf(a.primary) };
			return { command: `ls -la ${a.primary ?? "."}` };
		},
		aliases: { pattern: ["pattern"], path: ["path"], command: ["command"] },
	},
	shellArgs: SHELL_CAPABILITY,
	shellStreamArgs: SHELL_CAPABILITY,
	// A spawn IS a background request: run_in_background is forced true so a
	// dev server or watch command cannot block the turn. ZCode's TaskOutput
	// tool is how the model would poll it later.
	backgroundShellSpawnArgs: {
		...SHELL_CAPABILITY,
		build: (a) => ({
			...SHELL_CAPABILITY.build(a),
			run_in_background: true,
		}),
	},
	// WriteArgs | 1 path | 2 file_text.
	writeArgs: {
		names: ["Write"],
		build: (a) => ({
			file_path: stringOf(a.fields?.[1] ?? a.primary),
			content: typeof (a.fields?.[2] ?? a.second) === "string" ? (a.fields?.[2] ?? a.second) : "",
		}),
		aliases: { file_path: ["file_path", "path"], content: ["content", "file_text", "contents"] },
	},
	// FetchArgs | 1 url. ZCode's WebFetch requires a prompt alongside the url;
	// Cursor sends none, so a neutral one is synthesized — without it the call
	// would fail validation on arrival, every time.
	fetchArgs: {
		names: ["WebFetch", "Fetch"],
		build: (a) => ({
			url: stringOf(a.fields?.[1] ?? a.primary),
			prompt: "Fetch this URL and return its content.",
		}),
		aliases: { url: ["url"], prompt: ["prompt", "question", "instructions"] },
	},
	// SubagentArgs | 1 tool_call_id | 2 subagent_type | 3 model_id | 4 prompt |
	// 7 run_in_background. Cursor dispatches its own subagents natively; ZCode's
	// Agent tool is the same capability. `description` is required by the host
	// and sent by no one, so it is synthesized. model_id has no host parameter
	// and is dropped — the subagent runs on the host's configured model.
	subagentArgs: {
		names: ["Agent", "Task"],
		build: (a) => ({
			description: "Cursor subagent task",
			prompt: stringOf(a.fields?.[4]),
			subagent_type: stringOf(a.fields?.[2]),
			run_in_background: booleanOf(a.fields?.[7]),
		}),
		aliases: {
			description: ["description"],
			prompt: ["prompt"],
			subagent_type: ["subagent_type", "agent_type"],
			run_in_background: ["run_in_background"],
		},
	},
	// SubagentAwaitArgs | 1 agent_id | 2 timeout_ms — the same shape as the
	// host's TaskOutput {task_id, block, timeout}, not an approximation: it is
	// how a model polls a subagent it dispatched in the background.
	subagentAwaitArgs: {
		names: ["TaskOutput"],
		build: (a) => ({
			task_id: stringOf(a.fields?.[1]),
			block: true,
			timeout: numberOf(a.fields?.[2]) ?? 30_000,
		}),
		aliases: { task_id: ["task_id"], block: ["block"], timeout: ["timeout"] },
	},
	// --- Cursor's "pi" tool family (fields 45-51): a second, simpler set of
	// tool execs with its own arg numbering. Every one maps onto the same host
	// tools as the main family.
	// PiReadExecArgs | 1 path | 2 offset | 3 limit.
	piReadArgs: {
		names: ["Read"],
		build: (a) => ({
			file_path: stringOf(a.fields?.[1] ?? a.primary),
			offset: numberOf(a.fields?.[2]),
			limit: numberOf(a.fields?.[3]),
		}),
		aliases: { file_path: ["file_path", "path"], offset: ["offset"], limit: ["limit"] },
	},
	// PiBashExecArgs | 1 command | 2 timeout (ms, int64).
	piBashArgs: {
		names: ["Bash"],
		build: (a) => ({
			command: a.fields?.[1] ?? a.primary ?? "",
			timeout: numberOf(a.fields?.[2]),
		}),
		aliases: { command: ["command"], timeout: ["timeout"] },
	},
	// PiWriteExecArgs | 1 path | 2 content.
	piWriteArgs: {
		names: ["Write"],
		build: (a) => ({
			file_path: stringOf(a.fields?.[1]),
			content: typeof a.fields?.[2] === "string" ? a.fields[2] : "",
		}),
		aliases: { file_path: ["file_path", "path"], content: ["content", "file_text"] },
	},
	// PiGrepExecArgs | 1 pattern | 2 path | 3 glob | 4 ignore_case | 6 context |
	// 7 limit. `literal` (5) has no host parameter — ZCode's Grep is regex-only —
	// so it is dropped rather than approximated.
	piGrepArgs: {
		names: ["Grep"],
		build: (a) => ({
			pattern: stringOf(a.fields?.[1] ?? a.primary),
			path: stringOf(a.fields?.[2]),
			glob: stringOf(a.fields?.[3]),
			"-i": booleanOf(a.fields?.[4]),
			context: numberOf(a.fields?.[6]),
			head_limit: numberOf(a.fields?.[7]),
		}),
		aliases: {
			pattern: ["pattern", "query"],
			path: ["path"],
			glob: ["glob", "include"],
			"-i": ["-i", "case_insensitive"],
			context: ["context", "-C"],
			head_limit: ["head_limit"],
		},
	},
	// PiFindExecArgs | 1 pattern | 2 path | 3 limit.
	piFindArgs: {
		names: ["Glob"],
		build: (a) => ({
			pattern: stringOf(a.fields?.[1] ?? a.primary) ?? "*",
			path: stringOf(a.fields?.[2]),
		}),
		aliases: { pattern: ["pattern"], path: ["path"] },
	},
	// PiLsExecArgs | 1 path | 2 limit.
	piLsArgs: {
		names: ["Glob", "Bash"],
		build: (a, toolName) => {
			if (toolName === "Glob") return { pattern: "*", path: stringOf(a.fields?.[1] ?? a.primary) };
			return { command: `ls -la ${shq(a.fields?.[1] ?? a.primary ?? ".")}` };
		},
		aliases: { pattern: ["pattern"], path: ["path"], command: ["command"] },
	},
	// PiEditExecArgs | 1 path | 2 edits* ({old_text, new_text}). ZCode's Edit is
	// a single replacement per call: exactly one edit translates, and any other
	// count declines to the typed refusal so the model can re-issue per edit
	// instead of losing all but the first.
	piEditArgs: {
		names: ["Edit"],
		build: (a) => {
			const edits = Array.isArray(a.edits) ? a.edits : [];
			if (edits.length !== 1) return {};
			return {
				file_path: stringOf(a.fields?.[1]),
				old_string: edits[0].oldText,
				new_string: edits[0].newText,
			};
		},
		aliases: { file_path: ["file_path", "path"], old_string: ["old_string", "old_text"], new_string: ["new_string", "new_text"] },
	},
	// GetDiffRequest | 1 cwd | 2 ref | 3 base_ref | 4 merge_base | 5 target_paths*
	// | 6 unified_context_lines. There is no diff tool on the host, but there is
	// Bash, and `git diff` is exactly what the model would run itself; the call
	// still passes through the host's Bash permission system like any other.
	gitDiffRequestArgs: {
		names: ["Bash"],
		build: (a) => {
			const parts = ["git", "-C", shq(stringOf(a.fields?.[1]) ?? "."), "diff"];
			const ref = stringOf(a.fields?.[2]);
			const baseRef = stringOf(a.fields?.[3]);
			if (baseRef && ref) parts.push(shq(a.fields?.[4] === 1 || a.fields?.[4] === true ? `${baseRef}...${ref}` : `${baseRef} ${ref}`));
			else if (ref) parts.push(shq(ref));
			const unified = numberOf(a.fields?.[6]);
			if (unified !== undefined) parts.push(`-U${unified}`);
			const paths = Array.isArray(a.paths) ? a.paths.filter((p) => typeof p === "string" && p.length > 0) : [];
			if (paths.length > 0) parts.push("--", ...paths.map(shq));
			return { command: parts.join(" ") };
		},
		aliases: { command: ["command"] },
	},
};

/**
 * Map a Cursor built-in exec onto the host's registered tools.
 *
 * @param {object} exec a decoded ExecServerMessage with `case`, `field`, `args`.
 * @param {Set<string>} toolNames the tool names the host registered.
 * @param {Array} declared the host's tools[] entries, with JSON schemas.
 * @returns {{ toolName: string, arguments: string, callId: string } | null}
 *   `null` when no registered host tool can serve this exec — including when a
 *   required parameter cannot be produced; the caller then falls back to the
 *   typed rejection, which names the tools that do exist.
 */
export function translateBuiltinExec(exec, toolNames, declared) {
	if (!exec || typeof exec.field !== "number") return null;
	if (exec.case === "mcpArgs" || exec.case === "requestContextArgs") return null;

	const cap = CAPABILITY[exec.case];
	if (!cap) return null;

	const args = exec.args ?? {};
	const registered = [...toolNames];
	for (const candidate of cap.names) {
		if (!registered.includes(candidate)) continue;

		const entry = (declared ?? []).find((t) => t?.function?.name === candidate);
		const parameters = entry?.function?.parameters;
		const props = parameters?.properties;
		const required = parameters?.required;

		const built = cap.build(args, candidate);
		const hostArgs = {};
		for (const [field, value] of Object.entries(built)) {
			if (value === undefined) continue;
			const aliases = cap.aliases?.[field] ?? [field];
			// Prefer the alias the host's own schema declares; with no schema to
			// consult, the canonical (first) alias is the best available guess.
			const alias = props ? aliases.find((key) => key in props) : aliases[0];
			if (!alias) continue;
			hostArgs[alias] = value;
		}

		// The gate. Emitting a call the host will reject is worse than refusing:
		// the model sees the validation error, retries, and gets the same broken
		// shape back — a loop that only ends when the run is cut off.
		if (required) {
			const missing = required.filter((name) => !(name in hostArgs));
			if (missing.length > 0) continue;
		}

		return {
			toolName: candidate,
			arguments: JSON.stringify(hostArgs),
			callId: sanitizedCallId(exec.execId),
		};
	}
	return null;
}

/**
 * The live translation contract, in inspectable form: for every Cursor exec
 * case this build can translate, the host tools it may become and how each
 * argument is renamed. Served at `/internal/translation` so a future dig —
 * or a doctor — reads what the running shim actually does, not what a doc
 * said it did at some point.
 */
export function translationMap() {
	const entries = {};
	for (const [caseName, cap] of Object.entries(CAPABILITY)) {
		entries[caseName] = {
			tools: [...cap.names],
			args: Object.fromEntries(
				Object.entries(cap.aliases ?? {}).map(([field, aliases]) => [
					field,
					{ to: aliases[0], fallbacks: aliases.slice(1) },
				]),
			),
		};
	}
	return { execCases: entries };
}
