/**
 * Translation of Cursor's built-in tool execs into ZCode tool calls.
 *
 * Cursor's model natively calls its own file and shell tools (read, grep, shell
 * streams, ...). Refusing those forced the model through refusal loops; the
 * first-class behaviour is to translate each built-in into the host's registered
 * tool with matching arguments, so the model behaves exactly as it would in
 * Cursor while ZCode executes under its own permission system.
 *
 * Only tools the host actually registered are eligible — the name in the returned
 * call is always one ZCode declared, and the arguments are checked against the
 * host's own JSON schema so the parameter names match (path, not file_path).
 *
 * @module cursor-subscription/translate
 */

/**
 * Map a Cursor built-in exec onto the host's registered tools.
 *
 * @param {object} exec a decoded ExecServerMessage with `case`, `field`, `args`.
 * @param {Set<string>} toolNames the tool names the host registered.
 * @param {Array} declared the host's tools[] entries, with JSON schemas.
 * @returns {{ toolName: string, arguments: string, callId: string } | null}
 *   `null` when no registered host tool can serve this exec; the caller then
 *   falls back to the typed rejection.
 */
export function translateBuiltinExec(exec, toolNames, declared) {
	if (!exec || typeof exec.field !== "number") return null;
	if (exec.case === "mcpArgs" || exec.case === "requestContextArgs") return null;

	// Capability -> candidate host tool names, tried in order. Built from Cursor's
	// arg schemas and ZCode's captured tool schemas (see docs/CURSOR-PROTOCOL-SCHEMA.md).
	const CAPABILITY = {
		readArgs: { names: ["Read", "read"], build: (a) => ({ path: a.primary }) },
		grepArgs: { names: ["Grep", "grep"], build: (a) => ({ pattern: a.primary, path: a.second }) },
		lsArgs: {
			names: ["Glob", "Bash"],
			build: (a, toolName) =>
				toolName === "Glob" ? { pattern: "*", path: a.primary } : { command: `ls -la ${a.primary ?? "."}` },
		},
		shellArgs: { names: ["Bash", "Shell"], build: (a) => ({ command: a.primary ?? "" }) },
		shellStreamArgs: { names: ["Bash", "Shell"], build: (a) => ({ command: a.primary ?? "" }) },
		backgroundShellSpawnArgs: { names: ["Bash"], build: (a) => ({ command: a.primary ?? "" }) },
		writeArgs: { names: ["Write"], build: (a) => ({ path: a.primary, content: a.second ?? "" }) },
		fetchArgs: { names: ["WebFetch", "Fetch"], build: (a) => ({ url: a.primary }) },
	};
	const cap = CAPABILITY[exec.case];
	if (!cap) return null;

	const a = exec.args ?? {};
	const registered = [...toolNames];
	for (const candidate of cap.names) {
		if (!registered.includes(candidate)) continue;
		const built = cap.build(a, candidate);
		// Intersect with the host schema: drop keys the schema does not declare, and
		// keep required ones so ZCode's own validation still guards.
		const entry = (declared ?? []).find((t) => t?.function?.name === candidate);
		const props = entry?.function?.parameters?.properties;
		let args = built;
		if (props) {
			args = {};
			for (const [key, value] of Object.entries(built)) {
				if (key in props) args[key] = value;
			}
			for (const req of entry.function.parameters.required ?? []) {
				if (!(req in args) && req in built) args[req] = built[req];
			}
		}
		return {
			toolName: candidate,
			arguments: JSON.stringify(args),
			// Same sanitization: Cursor's execId can contain a newline (it joins two
			// ids), and a control character in the OpenAI tool_call id breaks the
			// host's pairing and rendering.
			callId: (exec.execId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) ||
				`call_${Math.random().toString(36).slice(2, 10)}`,
		};
	}
	return null;
}
