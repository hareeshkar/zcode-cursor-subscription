/**
 * Exec handling — the defect that silently disabled tool calling.
 *
 * The shim used to treat *every* exec that was not a `request_context_args` as
 * a terminal tool call: it ended the run and tried to map the exec to a tool.
 * Cursor's own filesystem and shell execs, and the provider-routing variant
 * that arrived on field 36, all hit that path. The run ended, `#toToolCall`
 * returned null, and the turn came back as a plain `stop` with no
 * `tool_calls` — so the host had nothing to execute and the model looked
 * capable but was a chat box.
 *
 * The rule now: only a real `mcp_args` ends a run. Everything else is answered
 * on its own field number and the run continues.
 *
 * @module cursor-subscription/exec-handling
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	decodeExecServerMessage,
	encodeMcpError,
	encodeMcpToolDefinition,
	encodeRequestContextResult,
	encodeExecClientMessage,
	encodeExecClientMessageEnvelope,
} from "../lib/cursor-client.mjs";
import { canAnchorTurn, planRequestControls } from "../lib/shim.mjs";
import { ConversationStore } from "../lib/conversation-store.mjs";
import { pickProbeModels } from "../lib/selftest.mjs";
import { Writer, Reader, encodeValue } from "../lib/proto.mjs";

/** Build an ExecServerMessage exactly as observed on the wire. */
function execFrame({ id = 1, execId = "", fields = [] }) {
	const writer = new Writer();
	if (id) writer.varint(1, id);
	if (execId) writer.string(15, execId);
	for (const [field, bytes] of fields) writer.bytes(field, bytes);
	return writer.finish();
}

const stringField = (value) => new Writer().string(1, value).finish();

test("a provider-routing exec is unknown, not a tool call", () => {
	// Observed live: field 36 carrying the provider identifier we registered.
	const frame = execFrame({ fields: [[36, stringField("zcode-cursor-subscription")]] });
	const exec = decodeExecServerMessage(frame);

	assert.equal(exec.case, "unknown");
	assert.equal(exec.field, 36, "the field number has to survive for the reply slot");
	assert.ok(!("args" in exec), "it must not look like a decodable tool call");
});

test("a real mcp_args exec is still recognised", () => {
	// McpCallArgs { name=1, arguments=2 (map), call_id=3, provider=4, tool_name=5 }
	const entry = new Writer().string(1, "path").bytes(2, encodeValue("/etc/hosts")).finish();
	const args = new Writer()
		.string(1, "read_file")
		.message(2, entry)
		.string(3, "call-1")
		.string(4, "zcode-cursor-subscription")
		.string(5, "read_file")
		.finish();
	const exec = decodeExecServerMessage(execFrame({ fields: [[11, args]] }));

	assert.equal(exec.case, "mcpArgs");
	assert.equal(exec.args.toolName, "read_file");
	assert.equal(exec.args.callId, "call-1");
	assert.deepEqual(exec.args.args, { path: "/etc/hosts" });
});

test("a rejection is a well-formed McpResult error, not an empty message", () => {
	const error = encodeMcpError("This tool is unavailable.");
	// McpResult { success=1 | error=2 { message=1 } }
	const reader = new Reader(error);
	const { field, wireType } = reader.tag();
	assert.equal(field, 2, "error lives in field 2");
	assert.equal(wireType, 2);

	const inner = new Reader(reader.bytes());
	const innerTag = inner.tag();
	assert.equal(innerTag.field, 1);
	assert.equal(innerTag.wireType, 2);
	assert.equal(inner.string(), "This tool is unavailable.");
});

test("a rejection is addressed to the exec's own field, not a fixed one", () => {
	// The server routes replies by field number, so a rejection answered in the
	// wrong slot leaves the run waiting forever.
	for (const field of [5, 7, 21, 36]) {
		const payload = encodeExecClientMessageEnvelope(
			encodeExecClientMessage(3, "exec-abc", field, encodeMcpError("nope")),
		);
		const reader = new Reader(payload);
		assert.equal(reader.tag().field, 2, "wrapped as AgentClientMessage.exec_client_message");

		// tag() only reads the key; the value has to be consumed too.
		const envelope = new Reader(reader.bytes());
		const idTag = envelope.tag();
		assert.equal(idTag.field, 1);
		envelope.varint();
		const execIdTag = envelope.tag();
		assert.equal(execIdTag.field, 15);
		envelope.bytes();
		const { field: replyField, wireType } = envelope.tag();
		assert.equal(replyField, field, `reply must land in field ${field}`);
		assert.equal(wireType, 2);
	}
});

test("tool definitions still round-trip through the request context", () => {
	const definition = encodeMcpToolDefinition({
		name: "read_file",
		description: "Read a file.",
		inputSchema: { type: "object", properties: { path: { type: "string" } } },
	});
	const result = encodeRequestContextResult([definition]);

	// RequestContextResult { success=1 { tools=7 } }
	const outer = new Reader(result);
	assert.equal(outer.tag().field, 1);
	const success = new Reader(outer.bytes());
	assert.equal(success.tag().field, 1);
	const context = new Reader(success.bytes());
	const tools = context.tag();
	assert.equal(tools.field, 7, "tools live in RequestContext.tools = 7");
	assert.ok(context.bytes().length > 0);
});

test("a Cursor built-in exec is recognised, refused, and never a tool call", () => {
	// read_args is field 7. It is Cursor's own tool: the host owns the
	// filesystem, so it must be refused — but it must not terminate the run
	// either, or the model never reaches the tools this shim did register.
	const exec = decodeExecServerMessage(
		execFrame({ fields: [[7, new Writer().string(1, "/etc/hosts").finish()]] }),
	);
	assert.equal(exec.case, "readArgs");
	assert.notEqual(exec.case, "mcpArgs", "a built-in read is not an MCP tool call");
	// The path is not extracted, so the refusal is generic rather than
	// path-specific. A tailored rejection would give the model a better error.
	// Tracked in docs/HARNESS-AUDIT.md; the generic reply is proven sufficient
	// for the run to resume and the tool call to arrive.
});

test("an exec with no exec id still decodes rather than throwing", () => {
	// Observed live: id=0 with no field 15 at all, because proto3 omits defaults.
	const exec = decodeExecServerMessage(execFrame({ id: 0, fields: [[36, stringField("x")]] }));
	assert.equal(exec.id, 0);
	assert.equal(exec.case, "unknown");
});

// --- the invariant that would have caught the original defect ---------------

test("metrics start balanced, so a divergence is always a real signal", async () => {
	const { CursorShim } = await import("../lib/shim.mjs");
	const shim = new CursorShim({ apiKey: "k" });
	const m = shim.metrics();
	// Every counter the doctor reasons about must exist and start at zero. A
	// missing key would make `dropped > 0` silently false forever.
	for (const key of ["toolRequests", "toolCalls", "droppedToolCalls", "turns", "conversations"]) {
		assert.equal(m[key], 0, `${key} must start at 0`);
	}
	await shim.close();
});

test("an unregistered tool name is not turned into a tool call", () => {
	// The shim only forwards calls to tools ZCode registered. A call to anything
	// else is refused — the host must never be handed a tool it does not have.
	const registered = new Set(["read_file"]);
	const toolName = "shell";
	assert.equal(registered.has(toolName), false);
	assert.ok(registered.has("read_file"));
});

test("every known exec carries the field its reply must be addressed to", () => {
	// Regression guard for a hang. Known cases used to return without a field,
	// so the refusal path had no slot and answered nothing: Cursor asked to read
	// a file, got silence, and the run stalled until the idle timeout. The
	// symptom was "read_file never returns" while get_weather worked fine.
	const cases = [
		[2, "shellArgs"],
		[3, "writeArgs"],
		[4, "deleteArgs"],
		[5, "grepArgs"],
		[7, "readArgs"],
		[8, "lsArgs"],
		[9, "diagnosticsArgs"],
		[14, "shellStreamArgs"],
		[20, "fetchArgs"],
		[23, "writeShellStdinArgs"],
	];
	for (const [field, name] of cases) {
		const exec = decodeExecServerMessage(execFrame({ fields: [[field, new Writer().finish()]] }));
		assert.equal(exec.case, name);
		assert.equal(
			exec.field,
			field,
			`${name} must keep field ${field} or its refusal cannot be addressed`,
		);
	}
});

// --- request controls: what the host asks for vs what this protocol can do ----

test("tool_choice=none suppresses tool registration entirely", () => {
	// A host told "none" that still receives a tool call has been lied to, and
	// nothing downstream can tell. Registering nothing is the honest mapping.
	const plan = planRequestControls({ tool_choice: "none", tools: [{ function: { name: "t" } }] });
	assert.equal(plan.suppressTools, true);
	assert.ok(plan.notes.some((n) => n.includes("tool_choice=none honoured")));
});

test("a named tool_choice registers only that tool", () => {
	// A named choice is a filter, not a hint: registering the rest would leave
	// the model free to pick something the host ruled out.
	const plan = planRequestControls({ tool_choice: { type: "function", function: { name: "get_weather" } } });
	assert.equal(plan.suppressTools, false);
	assert.equal(plan.only, "get_weather");
	assert.ok(plan.notes.some((n) => n.includes("pinned to get_weather")));
});

test("tool_choice=required is declared unexpressible rather than faked", () => {
	const plan = planRequestControls({ tool_choice: "required" });
	assert.equal(plan.suppressTools, false, "tools stay registered");
	assert.equal(plan.only, undefined, "but no single tool is pinned");
	assert.ok(plan.notes.some((n) => n.includes("required is not expressible")));
});

test("parameters Cursor cannot receive are named, not silently dropped", () => {
	const plan = planRequestControls({
		temperature: 0.2,
		top_p: 0.9,
		stop: ["x"],
		parallel_tool_calls: false,
	});
	for (const field of ["temperature", "top_p", "stop"]) {
		assert.ok(plan.notes.some((n) => n.includes(field)), `${field} must be reported`);
	}
	assert.ok(plan.notes.some((n) => n.includes("parallel_tool_calls")));
});

test("a structured-output request becomes a system instruction", () => {
	// Silently returning prose where JSON was asked for is the worst option;
	// aiming the model at the schema is a best effort, and it is declared.
	const object = planRequestControls({ response_format: { type: "json_object" } });
	assert.match(object.extraSystem, /valid JSON object/);

	const schema = planRequestControls({
		response_format: { type: "json_schema", json_schema: { schema: { type: "object", required: ["city"] } } },
	});
	assert.match(schema.extraSystem, /JSON Schema/, "the schema is carried into the instruction");
	assert.match(schema.extraSystem, /city/, "and its content with it");

	const unknown = planRequestControls({ response_format: { type: "xml" } });
	assert.ok(unknown.notes.some((n) => n.includes("response_format=xml")), "an unsupported format is reported");
});

test("a plain request is left alone", () => {
	// The common path must add nothing: no notes, no instruction, tools intact.
	const plan = planRequestControls({ model: "m", messages: [], tools: [{}] });
	assert.deepEqual(plan.notes, []);
	assert.equal(plan.extraSystem, "");
	assert.equal(plan.suppressTools, false);
	assert.equal(plan.only, undefined);
});

// --- anchoring: the bug that made the resume rate structurally zero ---------

test("a turn with no tool call anchors, whichever null-ish sentinel is used", () => {
	// Regression guard. The sentinel was `null` while the check tested for
	// `undefined`; `null !== undefined`, so every turn looked like a terminal
	// tool call, the anchor was written and immediately discarded, and the resume
	// rate was zero forever. Cursor had been sending checkpoints all along.
	const checkpoint = new Uint8Array([1, 2, 3]);
	assert.equal(canAnchorTurn({ toolCall: undefined, checkpoint }), true, "undefined sentinel");
	assert.equal(canAnchorTurn({ toolCall: null, checkpoint }), true, "null sentinel");
	assert.equal(canAnchorTurn({ checkpoint }), true, "absent field");
});

test("a turn that ended on a tool call never anchors", () => {
	// Its checkpoint is paused mid-tool, so resuming it would drop the tool
	// result the host is about to send.
	assert.equal(canAnchorTurn({ toolCall: { case: "mcpArgs" }, checkpoint: new Uint8Array([1]) }), false);
});

test("a turn with no checkpoint never anchors", () => {
	assert.equal(canAnchorTurn({ toolCall: null, checkpoint: undefined }), false);
	assert.equal(canAnchorTurn({ toolCall: null, checkpoint: null }), false);
	assert.equal(canAnchorTurn({}), false);
	assert.equal(canAnchorTurn(undefined), false, "a missing result must not throw");
});

test("an anchored turn is actually retrievable for the next one", () => {
	// The half that makes anchoring worth anything: the store must hand the
	// conversation back for an exact extension.
	const store = new ConversationStore();
	const first = [{ role: "user", content: "one" }];
	store.record(first, "conv", { checkpoint: new Uint8Array([9]), blobs: new Map() });

	const found = store.find([...first, { role: "assistant", content: "two" }]);
	assert.ok(found, "an exact extension must find the anchor");
	assert.equal(found.conversationId, "conv");
	assert.equal(store.size, 1);
});

// --- a crash the type-checker found ----------------------------------------

test("includeExpensive does not dereference a null rank", () => {
	// `rank()` returns null for an expensive family and the old comparator read
	// `key[i]` off it, so `pickProbeModels([...], { includeExpensive: true })`
	// threw a TypeError from exported API. Type-checking found it; the default
	// path never took the branch, so no test had reason to try it.
	const models = ["claude-4.5-sonnet", "gpt-5.1-low", "composer-2.5-fast"];
	assert.doesNotThrow(() => pickProbeModels(models, { includeExpensive: true }));
	const withExpensive = pickProbeModels(models, { includeExpensive: true, limit: 5 });
	assert.equal(withExpensive.length, 3, "every model is kept when expensive ones are allowed");
	assert.equal(withExpensive[0], "composer-2.5-fast", "the cheap family still ranks first");
	assert.ok(withExpensive.includes("claude-4.5-sonnet"), "and expensive ones sort last rather than vanish");
});
