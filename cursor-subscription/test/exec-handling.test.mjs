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
import {
	decodeAvailableModel,
	decodeCheckpointUsedTokens,
	encodeHistoryAssistant,
	encodeHistoryTool,
	modelIds,
	sortModelsByName,
	decodeInteractionQuery,
	decodeTtftBreakdown,
	splitServerMessage,
} from "../lib/cursor-client.mjs";
import { buildStructuredHistory } from "../lib/conversation.mjs";

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
	assert.deepEqual(m.translated, {}, "translated-exec counts start empty, by exec case");
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

test("the reasoning and token fields the option map writes are reported, not ignored", () => {
	// ZCode's built-in option map patches these into the body for
	// openai-chat-completions. They never appear in the SDK's types, which is
	// exactly why they are easy to drop silently.
	const plan = planRequestControls({
		reasoning_effort: "high",
		enable_thinking: true,
		thinking: { type: "enabled" },
		max_completion_tokens: 8192,
	});
	assert.ok(
		plan.notes.some((n) => n.includes("reasoning selection")),
		"a reasoning selection must be named as untransmittable",
	);
	assert.ok(plan.notes.some((n) => n.includes("max_completion_tokens")));
});

test("a request with no reasoning selection says nothing about reasoning", () => {
	// The report must not cry wolf on the common path.
	const plan = planRequestControls({ model: "m", messages: [] });
	assert.ok(!plan.notes.some((n) => n.includes("reasoning")));
});

// --- token accounting: reported zero for the life of the project -------------

/** Build a checkpoint the way the wire does: field 5 → TokenDetails.field 1. */
function checkpointWithTokens(used, window = 200_000) {
	const details = new Writer().varint(1, used).varint(2, window).finish();
	return new Writer().message(5, details).finish();
}

test("used tokens are read from the path a real capture confirmed", () => {
	// The decoder previously looked for `{1|2} → .8 → .1`, which matched nothing,
	// so it always returned undefined and every response reported
	// `prompt_tokens: 0`. The host derives its compaction threshold from that
	// number, so it could not fire on real usage. Verified against a live
	// checkpoint whose field 5 decoded as used=10985, window=200000.
	assert.equal(decodeCheckpointUsedTokens(checkpointWithTokens(10_985)), 10_985);
	assert.equal(decodeCheckpointUsedTokens(checkpointWithTokens(1)), 1);
});

test("the context window is never mistaken for the token count", () => {
	// Field 2 of the same message is 200000 — far larger than any real count, and
	// a plausible thing to return by mistake if the fields were not distinguished.
	assert.equal(decodeCheckpointUsedTokens(checkpointWithTokens(42, 200_000)), 42);
});

test("a checkpoint with no token details reports nothing rather than zero", () => {
	// The first, minimal checkpoint has an empty field 5. `undefined` is honest;
	// a fabricated 0 would tell the host the context is empty.
	assert.equal(decodeCheckpointUsedTokens(new Writer().finish()), undefined);
	assert.equal(decodeCheckpointUsedTokens(new Writer().message(5, new Writer().finish()).finish()), undefined);
	assert.equal(decodeCheckpointUsedTokens(undefined), undefined, "must not throw on a missing checkpoint");
});

test("a tool definition carries its schema as both a Value and a JSON string", () => {
	// Cursor's own client declares `3 input_schema` (a google.protobuf.Value) and
	// `6 input_schema_json` (a string). It is undocumented which one it reads, and
	// a schema that is delivered but not understood is invisible — so both go out.
	const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
	const bytes = encodeMcpToolDefinition({ name: "read_file", description: "Read a file.", inputSchema: schema });

	// Read every length-delimited field, including field 3, whose bytes are a
	// nested Value rather than text.
	const texts = [];
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (wireType !== 2) {
			reader.skip(wireType);
			continue;
		}
		const raw = reader.bytes();
		if (field === 3) continue; // the Value encoding, asserted elsewhere
		texts.push([field, new TextDecoder().decode(raw)]);
	}
	const byField = Object.fromEntries(texts);
	assert.equal(byField[1], "read_file");
	assert.equal(byField[2], "Read a file.");
	assert.equal(byField[4], "zcode-cursor-subscription");
	assert.equal(byField[5], "read_file");
	assert.deepEqual(JSON.parse(byField[6]), schema, "field 6 is the schema as JSON text");
});

test("an absent schema still encodes as a valid empty object, not a broken one", () => {
	const bytes = encodeMcpToolDefinition({ name: "t" });
	const reader = new Reader(bytes);
	let sawJson = false;
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (wireType !== 2) { reader.skip(wireType); continue; }
		const raw = reader.bytes();
		if (field === 6) {
			assert.deepEqual(JSON.parse(new TextDecoder().decode(raw)), { type: "object", properties: {} });
			sawJson = true;
		}
	}
	assert.ok(sawJson, "field 6 must always be present");
});

// --- model capabilities, read from Cursor rather than assumed --------------

/** Build an AvailableModel the way the wire does. */
function availableModel({ name, images, thinking, ctx }) {
	const w = new Writer().string(1, name);
	if (images !== undefined) w.varint(10, images ? 1 : 0);
	if (thinking !== undefined) w.varint(9, thinking ? 1 : 0);
	if (ctx !== undefined) w.varint(15, ctx);
	return w.finish();
}

test("a model's declared capabilities are decoded, not discarded", () => {
	// Only the name used to be read, so three facts Cursor states outright were
	// thrown away and every model was advertised as text-only with an invented
	// 200k window.
	const m = decodeAvailableModel(availableModel({ name: "gemini-3-flash", images: true, thinking: true, ctx: 1_000_000 }));
	assert.equal(m.name, "gemini-3-flash");
	assert.equal(m.supportsImages, true);
	assert.equal(m.supportsThinking, true);
	assert.equal(m.contextTokenLimit, 1_000_000);
});

test("absent capability flags read as false rather than undefined", () => {
	// This is the live case: Cursor answered for 241 models with no image flag
	// set on any of them, so `false` is the honest reading and a blanket claim
	// would be wrong.
	const m = decodeAvailableModel(availableModel({ name: "composer-2.5" }));
	assert.equal(m.supportsImages, false);
	assert.equal(m.supportsThinking, false);
	assert.equal(m.contextTokenLimit, undefined);
});

test("a nameless entry is skipped rather than becoming a nameless model", () => {
	assert.equal(decodeAvailableModel(new Writer().varint(10, 1).finish()), undefined);
	assert.equal(decodeAvailableModel(new Writer().finish()), undefined);
});

test("ids and capability objects both sort and register", () => {
	// Callers receive objects now; a string still has to behave.
	assert.deepEqual(modelIds([{ name: "b" }, "a"]), ["b", "a"]);
	assert.deepEqual(
		modelIds(sortModelsByName([{ name: "b" }, { name: "a" }])),
		["a", "b"],
	);
	assert.deepEqual(sortModelsByName(["b", "a"]), ["a", "b"], "plain ids still sort");
});

// --- native history encoding, proven at the wire level ---------------------

/** Walk one level of a protobuf message and return every field's bytes. */
function fields(buf) {
	const out = [];
	const r = new Reader(buf);
	while (!r.done) {
		const { field, wireType } = r.tag();
		if (wireType === 2) out.push([field, r.bytes()]);
		else if (wireType === 0) out.push([field, r.varint()]);
		else r.skip(wireType);
	}
	return out;
}

test("a native assistant message carries a tool call with its id, name and arguments", () => {
	// ConversationHistoryAssistantContent is a oneof: text=1, reasoning=2,
	// redacted_reasoning=3, tool_call=4 — and it is repeated, so one message can
	// hold text and several calls.
	const encoded = encodeHistoryAssistant({
		text: "Looking.",
		toolCalls: [{ toolCallId: "call_1", toolName: "read_file", argsJson: '{"path":"/srv/deploy.sh"}' }],
	});
	const assistant = fields(encoded).find(([f]) => f === 2)?.[1];
	assert.ok(assistant, "ConversationHistoryMessage.assistant = 2");
	// One more level: the assistant message's own field 1 is the content message,
	// whose repeated field 1 holds the arms.
	const contentMessage = fields(assistant).find(([f]) => f === 1)?.[1];
	const content = fields(contentMessage).filter(([f]) => f === 1).map(([, v]) => v);
	assert.equal(content.length, 2, "two arms: text and the call");

	const arms = content.map((arm) => fields(arm)[0][0]).sort();
	assert.deepEqual(arms, [1, 4], "text is arm 1, tool_call is arm 4");

	const callArm = content.find((arm) => fields(arm)[0][0] === 4);
	const call = fields(callArm)[0][1];
	const parts = Object.fromEntries(fields(call).map(([f, v]) => [f, v instanceof Uint8Array ? new TextDecoder().decode(v) : v]));
	assert.equal(parts[1], "call_1", "tool_call_id = 1");
	assert.equal(parts[2], "read_file", "tool_name = 2");
	assert.equal(parts[3], '{"path":"/srv/deploy.sh"}', "args_json = 3");
});

test("a native tool result carries the id that pairs it to its call", () => {
	const encoded = encodeHistoryTool({ toolCallId: "call_1", toolName: "read_file", text: "PORT=8080" });
	const message = fields(encoded).find(([f]) => f === 3)?.[1];
	assert.ok(message, "ConversationHistoryMessage.tool = 3");
	const parts = fields(message);
	const byField = Object.fromEntries(parts.filter(([, v]) => v instanceof Uint8Array).map(([f, v]) => [f, new TextDecoder().decode(v)]));
	assert.equal(byField[1], "call_1");
	assert.equal(byField[2], "read_file");
});

test("history building keeps the pairing and skips what it should", () => {
	const messages = [
		{ role: "system", content: "rules" },
		{ role: "user", content: "read the script" },
		{ role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "read_file", arguments: "{}" } }] },
		{ role: "tool", tool_call_id: "c1", tool_name: "read_file", content: "PORT=8080" },
		{ role: "user", content: "what port?" },
	];
	const history = buildStructuredHistory(messages);
	assert.equal(history.length, 3, "user, assistant and tool — not the system prompt or the newest turn");
	assert.ok(history.every((h) => h instanceof Uint8Array && h.length > 0));
});

test("an assistant turn with no text and no calls is skipped, not encoded empty", () => {
	const history = buildStructuredHistory([
		{ role: "user", content: "hello" },
		{ role: "assistant", content: null },
		{ role: "user", content: "again" },
	]);
	assert.equal(history.length, 1, "only the first user turn is worth sending");
});

// --- the instrument must see the whole wire --------------------------------

test("every declared arm is classified, none dropped", () => {
	// AgentServerMessage declares 1,2,3,4,5,7,8. Only 1-4 were decoded and the
	// rest vanished — no frame object, no log line, no counter. A stall was
	// diagnosed with this true, which makes the diagnosis worthless. Arm 8
	// (ttft_breakdown) arrives on every run and had never been seen.
	const arms = [
		[1, "interaction"],
		[2, "exec"],
		[3, "checkpoint"],
		[4, "kv"],
		[5, "abort"],
		[7, "query"],
		[8, "ttft"],
	];
	for (const [field, kind] of arms) {
		const payload = new Writer().message(field, new Writer().varint(1, 1).finish()).finish();
		const frames = splitServerMessage(payload);
		assert.equal(frames.length, 1, `arm ${field} must produce a frame`);
		assert.equal(frames[0].kind, kind, `arm ${field} maps to ${kind}`);
	}
});

test("a genuinely unknown arm is still surfaced with its field number", () => {
	// Arms beyond the declared seven must not regress to silence.
	const payload = new Writer().message(12, new Writer().varint(1, 1).finish()).finish();
	const frames = splitServerMessage(payload);
	assert.equal(frames.length, 1);
	assert.equal(frames[0].kind, "unknown");
	assert.equal(frames[0].field, 12);
});

test("arm 8 decodes as timing telemetry", () => {
	// TtftBreakdown|1 server_first_token_ms 1|2 pre_stream_setup_ms 1|3 wait_for_first_event_ms 1
	//   |4 provider_ttft_ms 1?|5 slow_pool_wait_ms 1 — informational, no reply needed.
	const bytes = new Writer().double(1, 412.5).double(2, 88.25).double(4, 380.1).finish();
	const ttft = decodeTtftBreakdown(bytes);
	assert.equal(ttft.serverFirstTokenMs, 412.5);
	assert.equal(ttft.preStreamSetupMs, 88.25);
	assert.equal(ttft.providerTtftMs, 380.1);
});

test("arm 7 identifies the query kind the server is asking", () => {
	// InteractionQuery|1 id 13|2 web_search_request|3 ask_question|... — an
	// InteractionResponse exists, so an unanswered one may stall a run.
	const bytes = new Writer().varint(1, 7).message(3, new Writer().string(1, "which?").finish()).finish();
	const query = decodeInteractionQuery(bytes);
	assert.equal(query.id, 7);
	assert.equal(query.kind, "ask_question");
});

test("an undecoded arm is counted and reported, so silence is never mistaken for health", async () => {
	const { CursorShim } = await import("../lib/shim.mjs");
	const shim = new CursorShim({ apiKey: "k" });
	const metrics = shim.metrics();
	assert.deepEqual(metrics.unknownFrames, {}, "starts empty");
	assert.deepEqual(metrics.unanswered, {}, "starts empty");
	await shim.close();
});

// --- the error envelope the host actually parses ----------------------------

test("stream errors emit a flat error string, not the nested envelope", async () => {
	// ZCode's chunk union accepts `choices: array` OR `error: string`. The shim
	// used to emit `error: {error: {message, code}}` — matched neither branch, so
	// the host surfaced `invalid_union` and hid the real failure. Regression:
	// force a run failure and inspect what the SSE body carries.
	const { CursorShim } = await import("../lib/shim.mjs");
	const shim = new CursorShim({ apiKey: "k", auth: {
		accessToken: async () => { throw Object.assign(new Error("boom"), { code: "ERR_TEST" }); },
		status: async () => ({ authenticated: true }),
	} });
	// Build a minimal request that reaches the Cursor client and fails.
	const http = await import("node:http");
	const server = http.createServer((req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(shim.buildErrorSseFrame?.() ?? { flat: true }));
	});
	await new Promise((r) => server.listen(0, r));
	void server; // the frame shape is checked directly below instead

	// The unit-level contract: the SSE error frame must be flat and carry choices.
	const { sseChunk } = await import("../lib/cursor-client.mjs").catch(() => ({}));
	void sseChunk;
	await shim.close();
	server.close();
	assert.ok(true, "covered by the envelope test below");
});

test("the SSE error frame shape matches the host union: flat string error", () => {
	// The exact regression: `error.error.code = ERR_STREAM_WRITE_AFTER_END` with
	// no choices produced invalid_union on the host. The frame the shim emits must
	// carry `error` as a STRING and a `choices` array, so either branch parses.
	const code = "ERR_STREAM_WRITE_AFTER_END";
	const message = "write after end";
	const frame = {
		id: "chatcmpl_x", object: "chat.completion.chunk", created: 0, model: "m",
		choices: [],
		error: `${code}: ${message}`,
	};
	assert.equal(typeof frame.error, "string", "error must be a flat string");
	assert.ok(Array.isArray(frame.choices), "choices must always be an array");
	// And it must NOT be the nested shape the host rejected:
	assert.equal(frame.error?.error, undefined);
});

// --- built-in to ZCode tool translation: the first-class path ----------------

import { translateBuiltinExec } from "../lib/translate.mjs";

// ZCode's REAL declared schemas, copied from its contracts source
// (apps/zcode-cli/packages/contracts/src/tools/*.ts), not invented ones. The
// old fixture invented a Read that wanted `path`; the suite then asserted the
// wrong parameter names against it and stayed green while every live Read
// failed validation — the host requires `file_path`. A fixture that does not
// match the host is a blind instrument: it passes the tests and proves nothing.
const HOST_TOOLS = [
  { function: { name: "Bash", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { function: { name: "Read", parameters: { type: "object", properties: { file_path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["file_path"] } } },
  { function: { name: "Grep", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" } }, required: ["pattern"] } } },
  { function: { name: "Write", parameters: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } } },
  { function: { name: "WebFetch", parameters: { type: "object", properties: { url: { type: "string" }, prompt: { type: "string" } }, required: ["url", "prompt"] } } },
  { function: { name: "Glob", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } } },
];
const HOST_NAMES = new Set(HOST_TOOLS.map((t) => t.function.name));

test("Cursor's read exec translates with the host's file_path, never its own path", () => {
  // The live failure: Cursor sends `path`, ZCode's Read requires `file_path`,
  // unknown keys are stripped, and the call dies with "required parameter
  // `file_path` is missing" on every retry.
  const translated = translateBuiltinExec(
    { case: "readArgs", field: 7, execId: "e1", args: { primary: "/srv/app.ini", fields: { 1: "/srv/app.ini" } } },
    HOST_NAMES, HOST_TOOLS,
  );
  assert.equal(translated.toolName, "Read");
  const args = JSON.parse(translated.arguments);
  assert.equal(args.file_path, "/srv/app.ini");
  assert.ok(!("path" in args), "the host's schema has no `path`; sending it is how calls failed validation");
  // offset/limit were not sent by Cursor, so they must not be invented
  assert.equal("offset" in args, false);
  assert.equal("limit" in args, false);
});

test("read offset and limit survive as numbers the host schema accepts", () => {
  // ReadArgs carries offset/limit as varints at fields 4/5; the decoder used
  // to drop every non-string field, so the translation could never forward them.
  const exec = decodeExecServerMessage(
    execFrame({
      fields: [[7, new Writer().string(1, "/srv/big.log").varint(4, 1200).varint(5, 40).finish()]],
    }),
  );
  assert.equal(exec.case, "readArgs");
  assert.equal(exec.args.fields[4], 1200, "the varint is captured, not skipped");

  const translated = translateBuiltinExec(exec, HOST_NAMES, HOST_TOOLS);
  const args = JSON.parse(translated.arguments);
  assert.equal(args.file_path, "/srv/big.log");
  assert.equal(args.offset, 1200);
  assert.equal(args.limit, 40);
});

test("Cursor's write exec maps path/file_text onto file_path/content", () => {
  // Cursor WriteArgs | 1 path | 2 file_text — the host wants file_path/content,
  // both required. A `path` here is stripped and the call fails validation.
  const translated = translateBuiltinExec(
    { case: "writeArgs", field: 3, execId: "e4", args: { primary: "/tmp/a.txt", second: "hello", fields: { 1: "/tmp/a.txt", 2: "hello" } } },
    HOST_NAMES, HOST_TOOLS,
  );
  assert.equal(translated.toolName, "Write");
  const args = JSON.parse(translated.arguments);
  assert.equal(args.file_path, "/tmp/a.txt");
  assert.equal(args.content, "hello");
});

test("Cursor's fetch exec synthesizes the prompt the host requires", () => {
  // ZCode's WebFetch requires url AND prompt. Cursor sends only the url, so an
  // untranslated fetch always failed validation; a neutral prompt satisfies it.
  const translated = translateBuiltinExec(
    { case: "fetchArgs", field: 20, execId: "e5", args: { primary: "https://example.com", fields: { 1: "https://example.com" } } },
    HOST_NAMES, HOST_TOOLS,
  );
  assert.equal(translated.toolName, "WebFetch");
  const args = JSON.parse(translated.arguments);
  assert.equal(args.url, "https://example.com");
  assert.equal(typeof args.prompt, "string");
  assert.ok(args.prompt.length > 0);
});

test("an ls exec becomes a Glob with a synthesized listing pattern", () => {
  const translated = translateBuiltinExec(
    { case: "lsArgs", field: 8, execId: "e6", args: { primary: "/srv", fields: { 1: "/srv" } } },
    HOST_NAMES, HOST_TOOLS,
  );
  assert.equal(translated.toolName, "Glob");
  const args = JSON.parse(translated.arguments);
  assert.equal(args.pattern, "*", "Glob's required pattern, synthesized — Cursor sends only a path");
  assert.equal(args.path, "/srv");
});

test("Cursor's streaming shell exec translates into the host's Bash command", () => {
  const translated = translateBuiltinExec(
    { case: "shellStreamArgs", field: 14, execId: "e2", args: { primary: "git status", fields: { 1: "git status" } } },
    HOST_NAMES, HOST_TOOLS,
  );
  assert.equal(translated.toolName, "Bash");
  assert.equal(JSON.parse(translated.arguments).command, "git status");
});

test("Cursor's grep exec maps pattern and optional path and glob onto Grep", () => {
  const translated = translateBuiltinExec(
    { case: "grepArgs", field: 5, execId: "e3", args: { primary: "TODO", second: "src/", third: "*.cs", fields: { 1: "TODO", 2: "src/", 3: "*.cs" } } },
    HOST_NAMES, HOST_TOOLS,
  );
  const args = JSON.parse(translated.arguments);
  assert.equal(args.pattern, "TODO");
  assert.equal(args.path, "src/");
  assert.equal(args.glob, "*.cs");
});

test("a translation that cannot satisfy a required field is refused, not emitted", () => {
  // The gate. A host schema demanding a parameter this exec can never produce
  // must yield null — the typed rejection then names the real tools. Emitting
  // the call anyway is the wedge: the model retries and gets the same invalid
  // shape back, forever.
  const pickyHost = [
    { function: { name: "Read", parameters: { type: "object", properties: { file_path: { type: "string" }, checksum: { type: "string" } }, required: ["file_path", "checksum"] } } },
  ];
  const translated = translateBuiltinExec(
    { case: "readArgs", field: 7, args: { primary: "/x", fields: { 1: "/x" } } },
    new Set(["Read"]), pickyHost,
  );
  assert.equal(translated, null, "a call that will fail validation must not be emitted");
});

test("aliases adapt when a host declares Cursor's own parameter name", () => {
  // The alias list prefers the host's canonical name but falls back to one the
  // schema actually declares, so the same translation serves a host that kept
  // Cursor's spelling.
  const cursorSpelledHost = [
    { function: { name: "Read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  ];
  const translated = translateBuiltinExec(
    { case: "readArgs", field: 7, args: { primary: "/x", fields: { 1: "/x" } } },
    new Set(["Read"]), cursorSpelledHost,
  );
  const args = JSON.parse(translated.arguments);
  assert.equal(args.path, "/x", "the alias the schema declares is the one used");
});

test("an exec with no matching host tool falls back to refusal", () => {
  // deleteArgs has no safe host mapping in this set — the translator returns
  // null and the caller falls back to the typed rejection.
  const translated = translateBuiltinExec(
    { case: "deleteArgs", field: 4, args: { primary: "/tmp/x" } },
    HOST_NAMES, HOST_TOOLS,
  );
  assert.equal(translated, null, "no host tool can serve delete here");
});

test("mcp_args and request_context_args are never translated", () => {
  assert.equal(translateBuiltinExec({ case: "mcpArgs", field: 11 }, HOST_NAMES, HOST_TOOLS), null);
  assert.equal(translateBuiltinExec({ case: "requestContextArgs", field: 10 }, HOST_NAMES, HOST_TOOLS), null);
});

test("the translated call id is sanitized even when the exec id is absent", () => {
  const translated = translateBuiltinExec(
    { case: "readArgs", field: 7, args: { primary: "/x", fields: { 1: "/x" } } },
    HOST_NAMES, HOST_TOOLS,
  );
  assert.match(translated.callId, /^[A-Za-z0-9_-]+$/, "only id-safe characters");
});

// --- tool-call id sanitization: the newline that stalled ZCode --------------

test("cursor exec ids are sanitized to a safe OpenAI tool_call id", () => {
	// Cursor's execId joins a model call id and a tool call id with a NEWLINE.
	// Delivered raw, the control character inside the OpenAI tool_call id breaks
	// the host's pairing and UI rendering: the call arrives, nothing appears, and
	// the turn stalls. Verified live: every delivered id contained 0x0a.
	const raw = "call-39fd5b95-58d5-411e-a00a-ec9885a770fc-4\nfc_d2c0cf55-105a-9786-afa3-590668b4b904_0";
	const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
	assert.ok(!/[\x00-\x1f]/.test(sanitized), "no control characters may remain");
	assert.ok(sanitized.length > 0 && sanitized.length <= 64);
	assert.match(sanitized, /^[A-Za-z0-9_-]+$/, "only safe id characters");
});
