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

/**
 * A finite number, accepting the varint the decoder produced or a numeric
 * string — Cursor has sent both shapes for line numbers.
 */
function numberOf(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

/** Sanitize Cursor's execId into a safe OpenAI tool_call id. */
function sanitizedCallId(execId) {
	// Cursor's execId joins two ids with a literal newline; a control character
	// in the OpenAI tool_call id breaks the host's pairing and rendering.
	return (
		(execId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) ||
		`call_${Math.random().toString(36).slice(2, 10)}`
	);
}

/**
 * Cursor exec case → host tool candidates.
 *
 * `build` produces Cursor-semantics fields; `aliases` maps each to the host's
 * parameter names, most-preferred first — the alias actually used is the first
 * one the host's declared schema knows.
 */
const CAPABILITY = {
	// ReadArgs | 1 path | 4 offset | 5 limit — offset/limit are 1-based lines
	// on both sides, so they pass through unchanged.
	readArgs: {
		names: ["Read"],
		build: (a) => ({
			file_path: stringOf(a.fields?.[1] ?? a.primary),
			offset: numberOf(a.fields?.[4]),
			limit: numberOf(a.fields?.[5]),
		}),
		aliases: { file_path: ["file_path", "path"], offset: ["offset"], limit: ["limit"] },
	},
	// GrepArgs | 1 pattern | 2 path | 3 include glob.
	grepArgs: {
		names: ["Grep"],
		build: (a) => ({
			pattern: stringOf(a.fields?.[1] ?? a.primary),
			path: stringOf(a.fields?.[2] ?? a.second),
			glob: stringOf(a.fields?.[3] ?? a.third),
		}),
		aliases: { pattern: ["pattern", "query"], path: ["path"], glob: ["glob", "include"] },
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
	shellArgs: {
		names: ["Bash", "Shell"],
		build: (a) => ({ command: a.fields?.[1] ?? a.primary ?? "" }),
		aliases: { command: ["command"] },
	},
	shellStreamArgs: {
		names: ["Bash", "Shell"],
		build: (a) => ({ command: a.fields?.[1] ?? a.primary ?? "" }),
		aliases: { command: ["command"] },
	},
	backgroundShellSpawnArgs: {
		names: ["Bash"],
		build: (a) => ({ command: a.fields?.[1] ?? a.primary ?? "" }),
		aliases: { command: ["command"] },
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
