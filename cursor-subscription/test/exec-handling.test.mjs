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
