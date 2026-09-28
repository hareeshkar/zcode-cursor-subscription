/**
 * OpenAI-compatible shim over Cursor's Agent service.
 *
 * ZCode speaks `openai-chat-completions`; Cursor speaks Connect-RPC + protobuf
 * over HTTP/2. This file is the boundary between them.
 *
 * Design rules, from docs/RESEARCH-FINDINGS.md §6.11 — the shim owns the boundary
 * and nothing else:
 *
 *   it owns      token-accurate usage, resume-vs-replay, deterministic
 *                serialisation, tool-call translation, refusing unsupported
 *                Cursor execs
 *   it must not  compact, summarise, prune, reorder or rewrite messages
 *
 * Adding tokens of our own to the prompt, or "helpfully" tidying history, would
 * fight ZCode's context builder and make the context meter lie. Transparency is
 * the feature.
 *
 * @module cursor-subscription/shim
 */

import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";

import {
	ADOPTION_CHECK_INTERVAL_MS,
	DEFAULT_SHIM_PORT,
	FALLBACK_MODELS,
	PORT_SCAN_RANGE,
	SHIM_HOST,
	readRecordedPort,
	recordPort,
} from "./config.mjs";
import { AuthError, CursorAuthService } from "./auth.mjs";
import { CredentialStore } from "./credentials.mjs";
import { ConversationStore, planTurn } from "./conversation-store.mjs";
import { buildRunRequest } from "./conversation.mjs";
import {
	AgentRun,
	decodeCheckpointUsedTokens,
	decodeExecServerMessage,
	decodeInteractionUpdate,
	decodeKvServerMessage,
	encodeGetBlobResult,
	encodeKvClientMessage,
	encodeMcpToolDefinition,
	encodeSetBlobResult,
	fetchUsableModels,
	splitServerMessage,
	sortModelsByName,
} from "./cursor-client.mjs";

/** Told to Cursor when it asks for a tool this shim will not run. */
export const TOOL_REJECT_REASON =
	"This tool is unavailable. Use the tools the host agent provides instead.";

/**
 * Identifier returned by `/health` so one shim can recognise another's answer.
 *
 * A status code cannot do this job: any unrelated local server replies 200 to a
 * GET, and treating that as a provider yields an entry that cannot serve a
 * single completion.
 */
export const SHIM_SERVICE = "cursor-subscription-shim";

/**
 * Ceilings on exec traffic within a single run.
 *
 * Refusing an exec and continuing is a loop unless something bounds it. A model
 * that re-asks a refused tool forever would burn the user's quota and hold the
 * host's model stream open until its idle timeout, so the run is ended and
 * reported instead. Both are far above anything a converging turn produces —
 * a working tool call is typically the third exec.
 */
const MAX_EXECS_PER_RUN = 24;
const MAX_REFUSALS_PER_FIELD = 6;

// ---------------------------------------------------------------------------
// OpenAI message → Cursor conversation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SSE plumbing
// ---------------------------------------------------------------------------

const sseChunk = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const DONE = "data: [DONE]\n\n";

function openAiError(message, type = "cursor_error", code = "cursor_error") {
	return { error: { message, type, param: null, code } };
}

/**
 * A fault attributable to the caller, not to the shim.
 *
 * Exists so the distinction survives the async boundary: a thrown `Error` from
 * request handling is a 5xx, and a client mistake reported as a 5xx is a lie
 * the host will act on.
 */
class ClientError extends Error {
	constructor(message, type = "invalid_request", code = "bad_request", status = 400) {
		super(message);
		this.name = "ClientError";
		this.type = type;
		this.code = code;
		this.status = status;
	}
}

/**
 * Translate the host's request controls into what this shim can actually do.
 *
 * Pure and exported so the mapping is testable without a live call. What it
 * decides — whether to register tools at all, whether a structured-output
 * request can be honoured — is exactly the kind of thing that drifts silently.
 */
export function planRequestControls(body = {}) {
	const notes = [];
	const choice = body.tool_choice;
	const only =
		choice && typeof choice === "object" && typeof choice.function?.name === "string"
			? choice.function.name
			: undefined;
	const suppressTools = choice === "none";

	// Cursor's run request has no field for any of these, so each is either
	// honoured by construction or declared as an approximation. Ignoring one is
	// not neutral: a host told "none" that still receives a tool call has been
	// lied to, and nothing downstream can tell.
	if (choice === "required") notes.push("tool_choice=required is not expressible; the model may answer in prose");
	if (suppressTools) notes.push("tool_choice=none honoured: no tools registered");
	if (only) notes.push("tool_choice pinned to " + only + "; other tools were not registered");
	if (body.parallel_tool_calls === false) {
		notes.push("parallel_tool_calls=false honoured: the run ends at the first tool call");
	}
	for (const field of ["temperature", "top_p", "stop", "seed", "frequency_penalty", "presence_penalty"]) {
		if (body[field] !== undefined) notes.push(field + " is not expressible in Cursor's run request");
	}

	let extraSystem = "";
	const format = body.response_format;
	if (format && typeof format === "object") {
		if (format.type === "json_object") {
			extraSystem = "Respond with a single valid JSON object and nothing else.";
		} else if (format.type === "json_schema") {
			extraSystem =
				"Respond with a single valid JSON value that conforms to this JSON Schema, and nothing else:\n" +
				JSON.stringify(format.json_schema?.schema ?? {});
		} else if (format.type && format.type !== "text") {
			notes.push("response_format=" + format.type + " is not supported; the model may answer in prose");
		}
	}
	return { suppressTools, only, extraSystem, notes };
}


/**
 * May this turn's checkpoint be used to resume the next one?
 *
 * Exported and pure so the rule is testable, because getting it wrong is
 * invisible: the anchor is written and then silently discarded, no error is
 * raised anywhere, and the only symptom is a resume rate that is structurally
 * zero. That is exactly what happened — the sentinel for "no tool call" was
 * `null` while this check tested for `undefined`, and `null !== undefined`, so
 * **every turn ever run** was treated as a terminal tool call and its anchor
 * thrown away. Cursor had been sending checkpoints the whole time.
 *
 * A turn that ended on a tool call must not anchor: its checkpoint is paused
 * mid-tool, so resuming it would drop the tool result the host is about to send.
 *
 * @param {{ toolCall?: unknown, checkpoint?: unknown }} result
 */
export function canAnchorTurn(result) {
	// `== null` covers `null` and `undefined` alike. Testing one and storing the
	// other is the whole bug, so the check is deliberately total.
	if (result?.toolCall != null) return false;
	if (result?.checkpoint == null) return false;
	return true;
}

// ---------------------------------------------------------------------------
// Shim
// ---------------------------------------------------------------------------

/**
 * Ports to try, in order, deduplicated.
 *
 * Exported so the ordering is unit-testable on its own. The configured port
 * always comes first, then whatever worked last time — that ordering is what
 * keeps the address stable across restarts, which ZCode needs because it
 * resolves the provider by a literal base URL.
 */
export function portCandidates(preferred, { recorded, span = PORT_SCAN_RANGE } = {}) {
	const wanted = [preferred, recorded, DEFAULT_SHIM_PORT];
	const out = [];
	for (const port of wanted) {
		if (Number.isInteger(port) && port > 0 && port < 65_536 && !out.includes(port)) {
			out.push(port);
		}
	}
	for (let offset = 1; offset < span; offset += 1) {
		const port = DEFAULT_SHIM_PORT + offset;
		if (!out.includes(port)) out.push(port);
	}
	return out;
}

export class CursorShim {
	#store;
	#auth;
	#conversations = new ConversationStore();
	#apiKey;
	#server;
	#bound;
	#settling;
	#preferredPort;
	#adoptedPort = null;
	#adoptionTimer;
	#stats = { turns: 0, resumed: 0, replayed: 0, toolCalls: 0, toolRequests: 0, droppedToolCalls: 0 };
	// Liveness. There is no model-status endpoint in Cursor's protocol, so the
	// only honest answer to "is the model stuck?" is when the last frame arrived
	// and what we last did with it. Frames still arriving means the model is
	// working; silence right after an unanswered exec means it is waiting on us.
	#liveness = { frames: 0, lastFrameAt: 0, lastAction: "none" };
	/** Host requests the shim cannot express, surfaced rather than swallowed. */
	#approximations = new Map();

	constructor(options = {}) {
		this.#store = options.store ?? new CredentialStore();
		this.#auth = options.auth ?? new CursorAuthService(this.#store);
		this.#apiKey = options.apiKey ?? "";
		this.#preferredPort = options.port ?? DEFAULT_SHIM_PORT;
		/**
		 * The port actually in use, which is the one every caller must build URLs
		 * from. It equals the preferred port until a clash forces a move, and it
		 * is deliberately not reset — a caller that read it before `listen()`
		 * resolved must still end up with a usable address.
		 */
		this.port = this.#preferredPort;
		this.host = options.host ?? SHIM_HOST;
		this.log = options.log ?? (() => {});
	}

	/** The port the caller asked for, whether or not it was free. */
	get preferredPort() {
		return this.#preferredPort;
	}

	/** True once the port in use is known to differ from the preferred one. */
	get movedPort() {
		return this.port !== this.#preferredPort;
	}

	/**
	 * The local API key, exposed so the management surface can print the exact
	 * value a user must paste into the ZCode provider entry. It is a loopback
	 * credential, never a Cursor secret.
	 */
	get apiKey() {
		return this.#apiKey;
	}

	/** Aggregate counters, exposed through the management tool. */
	/**
	 * Everything the management surface reports.
	 *
	 * `frames`, `lastFrameAt` and `lastAction` are the honest answer to "is the
	 * model stuck?". There is no model-status endpoint in Cursor's protocol, so
	 * the only evidence is whether frames are still arriving and what was last
	 * done with them: traffic means the model is working, silence right after
	 * an exec we did not answer means it is waiting on us.
	 */
	metrics() {
		return {
			...this.#stats,
			resumeRate:
				this.#stats.turns === 0 ? 0 : Number((this.#stats.resumed / this.#stats.turns).toFixed(3)),
			conversations: this.#conversations.size,
			// The keys, not the counts: the Map is message → times-seen, and a bare
			// count would say nothing about what was approximated.
			approximations: [...this.#approximations.keys()],
			frames: this.#liveness.frames,
			lastFrameAt: this.#liveness.lastFrameAt,
			lastAction: this.#liveness.lastAction,
		};
	}

	/**
	 * Record a host request this shim cannot express faithfully.
	 *
	 * Silently dropping one is the failure this project exists to avoid: a host
	 * that asked for no tools, or for JSON, and got something else, has been lied
	 * to, and nothing downstream can tell.
	 */
	#note(message) {
		this.#approximations.set(message, (this.#approximations.get(message) ?? 0) + 1);
	}

	resetMetrics() {
		this.#stats = { turns: 0, resumed: 0, replayed: 0, toolCalls: 0, toolRequests: 0, droppedToolCalls: 0 };
		this.#liveness = { frames: 0, lastFrameAt: 0, lastAction: "none" };
		this.#approximations.clear();
		this.#conversations.clear();
	}

	/**
	 * Resolves with `{ ok: true, port, adopted }` once a usable port is settled,
	 * or `{ ok: false, error }` if none could be bound. Never rejects, so a
	 * caller that ignores it cannot produce an unhandled rejection.
	 * `null` before `listen()`.
	 *
	 * `adopted: true` means another process is already serving that port and this
	 * one deliberately did not bind.
	 */
	get bound() {
		return this.#bound ?? null;
	}

	listen() {
		if (this.#server) return this;
		this.#server = createServer((request, response) => {
			this.#handle(request, response).catch((error) => {
				if (!response.headersSent) {
					response.writeHead(500, { "content-type": "application/json" });
				}
				response.end(JSON.stringify(openAiError("shim failure", "shim_error", "shim_error")));
				this.log("shim request failed", error?.message);
			});
		});
		// `listen()` fails asynchronously: a bind clash arrives as an 'error'
		// event, never as a throw, so a try/catch around the call would miss it —
		// and an unhandled 'error' on a Server terminates the process. The shim
		// shares that process with the MCP tool server, so a port already held by
		// a sibling ZCode session would otherwise take every management tool down
		// with it. The clash is resolved here, never thrown.
		this.#bound = this.#settle();
		return this;
	}

	/**
	 * Settle on a usable port.
	 *
	 * Preference order is the configured port, then the port that worked last
	 * time, then the default, then a short upward scan. A port that turns out to
	 * be held by a healthy shim is adopted rather than duplicated: a second
	 * server would hold a second copy of the Cursor token and serve nothing.
	 */
	async #settle() {
		if (this.#settling) return this.#settling;
		this.#settling = this.#doSettle().finally(() => {
			this.#settling = undefined;
		});
		return this.#settling;
	}

	async #doSettle() {
		let lastError = null;
		for (const port of portCandidates(this.#preferredPort, { recorded: readRecordedPort() })) {
			const outcome = await this.#attempt(port);
			if (outcome.ok) {
				this.port = port;
				recordPort(port);
				this.#adoptedPort = null;
				this.#stopAdoptionWatch();
				return { ok: true, port, adopted: false };
			}
			lastError = outcome.error;
			// Only a clash is worth working around; anything else will fail again.
			if (outcome.error?.code !== "EADDRINUSE") break;
			if (await this.#servedByHealthyShim(port)) {
				this.port = port;
				this.#adoptedPort = port;
				this.#startAdoptionWatch();
				this.log("another shim already serves this port", `${this.host}:${port}`);
				return { ok: true, port, adopted: true };
			}
		}
		this.log("shim failed to listen", lastError?.message);
		return { ok: false, error: lastError };
	}

	/**
	 * Whether the port is genuinely being served right now.
	 *
	 * Adoption is a one-time decision, and that was a real failure: a second ZCode
	 * session adopted a healthy shim, the owner then exited, and the adopter went
	 * on reporting the port as served by "another instance" while nothing was
	 * listening — so every completion failed with `fetch failed` and the tools
	 * said everything was fine. Trusting the recorded decision is what made the
	 * diagnosis impossible. This asks the socket instead.
	 *
	 * @returns {Promise<{ ok: boolean, adopted: boolean, reason?: string }>}
	 */
	async servingState() {
		const outcome = await this.bound;
		if (!outcome?.ok) {
			return { ok: false, adopted: false, reason: outcome?.error?.message ?? "not bound" };
		}
		if (!outcome.adopted) return { ok: true, adopted: false };
		if (await this.#servedByHealthyShim(this.port)) return { ok: true, adopted: true };
		return {
			ok: false,
			adopted: true,
			reason: `nothing is answering on ${this.host}:${this.port} — the shim this process adopted has gone`,
		};
	}

	/**
	 * Take the port over when the adopted shim dies.
	 *
	 * Two ZCode sessions is the normal case, not an error, so whichever one lost
	 * the race watches for the winner to leave instead of sitting on a dead port
	 * for the rest of the session.
	 */
	#startAdoptionWatch() {
		if (this.#adoptionTimer) return;
		this.#adoptionTimer = setInterval(() => {
			this.#takeOverIfPeerGone().catch(() => {});
		}, ADOPTION_CHECK_INTERVAL_MS);
		// Never hold the process open for a background health check.
		this.#adoptionTimer.unref?.();
	}

	#stopAdoptionWatch() {
		if (!this.#adoptionTimer) return;
		clearInterval(this.#adoptionTimer);
		this.#adoptionTimer = undefined;
	}

	async #takeOverIfPeerGone() {
		const adopted = this.#adoptedPort;
		if (adopted === null) return;
		if (await this.#servedByHealthyShim(adopted)) return;
		this.log("the adopted shim is gone, taking over its port", `${this.host}:${adopted}`);
		await this.#settle();
	}

	/** One bind attempt. Never throws — the result carries the outcome. */
	#attempt(port) {
		return new Promise((resolve) => {
			const onListening = () => {
				this.#server.off("error", onError);
				resolve({ ok: true });
			};
			const onError = (error) => {
				this.#server.off("listening", onListening);
				resolve({ ok: false, error });
			};
			this.#server.once("listening", onListening);
			this.#server.once("error", onError);
			// Loopback only: this process holds a live Cursor bearer token and
			// must never be reachable from another host.
			this.#server.listen(port, this.host);
		});
	}

	/**
	 * Is a working shim already on that port?
	 *
	 * A status code is not enough to tell one: any unrelated local server
	 * answers a GET /health with 200 and would be adopted as a provider that
	 * cannot actually serve a chat completion. So the body has to name this
	 * service, and the request still carries the API key that gates the route.
	 */
	async #servedByHealthyShim(port) {
		try {
			const response = await fetch(`http://${this.host}:${port}/health`, {
				headers: { authorization: `Bearer ${this.#apiKey}` },
				signal: AbortSignal.timeout(1_500),
			});
			if (!response.ok) return false;
			const body = await response.json();
			return body?.ok === true && body?.service === SHIM_SERVICE;
		} catch {
			return false;
		}
	}

	async close() {
		this.#conversations.clear();
		this.#stopAdoptionWatch();
		// Settle the bind first, so a close that races a slow fallback does not
		// leave a half-attempted server behind.
		await this.#bound?.catch(() => {});
		await new Promise((resolve) => {
			if (!this.#server?.listening) return resolve();
			this.#server.close(resolve);
		});
	}

	#authorised(request) {
		// ZCode requires a non-blank API key for a provider entry, so the shim
		// always expects one. Compare in constant time.
		if (!this.#apiKey) return false;
		const header = request.headers.authorization ?? "";
		const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
		const a = Buffer.from(presented);
		const b = Buffer.from(this.#apiKey);
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	}

	async #handle(request, response) {
		if (!this.#authorised(request)) {
			response.writeHead(401, { "content-type": "application/json" });
			response.end(JSON.stringify(openAiError("invalid api key", "auth_error", "invalid_api_key")));
			return;
		}
		const url = new URL(request.url ?? "/", `http://${this.host}`);
		if (url.pathname === "/v1/models" && request.method === "GET") return this.#models(response);
		if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
			return this.#chatCompletions(request, response);
		}
		if (url.pathname === "/health" && request.method === "GET") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: true, service: SHIM_SERVICE, ...this.metrics() }));
			return;
		}
		response.writeHead(404, { "content-type": "application/json" });
		response.end(JSON.stringify(openAiError("not found", "not_found", "not_found")));
	}

	async #models(response) {
		let models = FALLBACK_MODELS;
		try {
			const token = await this.#auth.accessToken();
			const discovered = await fetchUsableModels(token);
			if (discovered.length > 0) models = sortModelsByName(discovered);
		} catch (error) {
			// Discovery is best-effort: the fallback list keeps the provider
			// selectable rather than failing the whole request.
			this.log("model discovery failed", error?.message);
		}
		const created = Math.floor(Date.now() / 1000);
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				object: "list",
				data: models.map((id) => ({ id, object: "model", created, owned_by: "cursor" })),
			}),
		);
	}

	/**
	 * Read and parse the request body.
	 *
	 * Throws a `ClientError` rather than letting a JSON syntax error escape as
	 * a generic failure: unparseable input is the caller's mistake, and
	 * reporting it as a shim fault sends the host looking for a server bug that
	 * does not exist.
	 */
	async #readBody(request) {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const raw = Buffer.concat(chunks).toString("utf8");
		if (raw.trim().length === 0) return {};
		try {
			const parsed = JSON.parse(raw);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new ClientError("request body must be a JSON object", "invalid_request", "bad_request");
			}
			return parsed;
		} catch (error) {
			if (error instanceof ClientError) throw error;
			throw new ClientError(`request body is not valid JSON (${error.message})`, "invalid_request", "bad_json");
		}
	}

	async #chatCompletions(request, response) {
		let body;
		try {
			body = await this.#readBody(request);
		} catch (error) {
			// A 4xx here, not a 5xx: the host can act on it, retry it is not worth.
			response.writeHead(error.status ?? 400, { "content-type": "application/json" });
			response.end(
				JSON.stringify(openAiError(error.message, error.type ?? "invalid_request", error.code ?? "bad_request")),
			);
			return;
		}
		const messages = Array.isArray(body.messages) ? body.messages : [];
		if (messages.length === 0) {
			response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify(openAiError("messages is required", "invalid_request", "no_messages")));
			return;
		}

		let accessToken;
		try {
			accessToken = await this.#auth.accessToken();
		} catch (error) {
			response.writeHead(401, { "content-type": "application/json" });
			const code = error instanceof AuthError ? error.code : "auth_failed";
			response.end(JSON.stringify(openAiError("Cursor sign-in required", "auth_error", code)));
			return;
		}

		this.#stats.turns += 1;

		// --- resume vs replay (see conversation-store.mjs) -------------------
		const anchor = this.#conversations.find(messages);
		let suffixStart = 0;
		let conversationId;
		if (anchor) {
			const plan = planTurn(anchor.committed, messages);
			if (plan.resumable) {
				conversationId = anchor.conversationId;
				suffixStart = messages.length - plan.suffix.length;
				this.#stats.resumed += 1;
			} else {
				this.#stats.replayed += 1;
			}
		} else {
			this.#stats.replayed += 1;
		}

		// The host's request controls, translated into what this protocol can
		// express. Anything it cannot is recorded rather than quietly ignored.
		const controls = planRequestControls(body);
		for (const note of controls.notes) this.#note(note);
		const extraSystem = controls.extraSystem;

		// Register the host's own tools with Cursor so the model calls *them*,
		// not Cursor's built-ins. This is what keeps execution inside ZCode.
		const declared = Array.isArray(body.tools) ? body.tools : [];
		const toolNames = new Set();
		const encodedTools = [];
		for (const tool of controls.suppressTools ? [] : declared) {
			const fn = tool?.function;
			const name = typeof fn?.name === "string" ? fn.name : "";
			if (!name) continue;
			// A named choice is a filter, not a hint: registering the rest would
			// leave the model free to pick something the host ruled out.
			if (controls.only && name !== controls.only) continue;
			toolNames.add(name);
			encodedTools.push(
				encodeMcpToolDefinition({
					name,
					description: String(fn.description ?? ""),
					// Cursor wants the bare JSON Schema; the OpenAI `function`
					// wrapper must not be forwarded.
					inputSchema: fn.parameters ?? { type: "object", properties: {} },
					toolName: name,
				}),
			);
		}

		const model = typeof body.model === "string" ? body.model : FALLBACK_MODELS[0];

		// The checkpoint Cursor returned last turn is the conversation state.
		// The prefix hash decided whether it still matches ZCode's history.
		// Seeded from the anchor: on a resumed run Cursor may re-ask for the
		// root-prompt blob, and answering empty would erase ZCode's system prompt
		// for the rest of the session.
		const blobStore = new Map(anchor?.blobs ?? []);
		const runRequest = buildRunRequest({
			messages,
			checkpoint: anchor?.checkpoint,
			blobStore,
			model,
		});

		const run = { toolNames, model, messages, blobStore, conversationId };
		return body.stream
			? this.#stream(response, runRequest, encodedTools, accessToken, run)
			: this.#complete(response, runRequest, encodedTools, accessToken, run);
	}

	/**
	 * Run one Cursor run and translate its frames.
	 *
	 * A Cursor run is bounded by one ZCode turn: when Cursor asks for a tool we
	 * end the run and hand the call back to ZCode, which owns tool execution and
	 * permission prompts. ZCode cannot answer mid-stream, so the alternative
	 * would be executing tools inside the shim and bypassing its prompts.
	 */
	async #collect(runRequest, tools, accessToken, blobStore, onDelta) {
		const run = new AgentRun(accessToken);
		await run.start({ runRequestBytes: runRequest, tools });

		let text = "";
		let reasoning = "";
		let execs = 0;
		const refusals = {};
		// `undefined`, not `null`: `#commit` tests `!== undefined`, so a `null`
		// sentinel made every turn look like a terminal tool call.
		let toolCall;
		let completionTokens = 0;
		let promptTokens = 0;
		let checkpoint;

		try {
			for await (const payload of run.frames()) {
				for (const frame of splitServerMessage(payload)) {
					this.#liveness.frames += 1;
					this.#liveness.lastFrameAt = Date.now();
					if (process.env.CURSOR_SHIM_DEBUG) {
						this.log(`frame kind=${frame.kind} bytes=${frame.payload?.length ?? 0}`);
					}
					if (frame.kind === "interaction") {
						const update = decodeInteractionUpdate(frame.payload);
						if (update.type === "textDelta") {
							text += update.text;
							// Forward immediately: buffering the whole run made
							// time-to-first-token equal the entire run, which reads as
							// a hang to the host and can trip its stream idle timeout.
							onDelta?.({ kind: "text", text: update.text });
						} else if (update.type === "thinkingDelta") {
							reasoning += update.text;
							onDelta?.({ kind: "reasoning", text: update.text });
						}
						else if (update.type === "tokenDelta") {
							if (Number.isFinite(update.tokens)) completionTokens += update.tokens;
						}
					} else if (frame.kind === "checkpoint") {
						// Field 3 IS the serialized ConversationState. Holding it is what
						// makes the next turn cheap: we send it back verbatim instead of
						// re-encoding ZCode history. Copy it — reader views alias the
						// frame buffer, which is reused as the stream continues.
						checkpoint = Uint8Array.from(frame.payload);
						const used = decodeCheckpointUsedTokens(checkpoint);
						if (used !== undefined) promptTokens = used;
					} else if (frame.kind === "kv") {
						// Blob handshake. A cold start publishes the harness system prompt
						// as a blob and Cursor fetches it here. Unanswered, the run stalls
						// before the model ever sees its instructions.
						const kv = decodeKvServerMessage(frame.payload);
						if (kv.case === "getBlobArgs") {
							const key = Buffer.from(kv.blobId ?? new Uint8Array(0)).toString("hex");
							run.writeMessage(
								encodeKvClientMessage(encodeGetBlobResult(kv.id, blobStore?.get(key))),
							);
						} else if (kv.case === "setBlobArgs") {
							if (kv.blobId !== undefined && kv.blobData !== undefined) {
								const key = Buffer.from(kv.blobId).toString("hex");
								blobStore?.set(key, Uint8Array.from(kv.blobData));
							}
							// Acknowledge, or the run waits on the handshake forever.
							run.writeMessage(encodeKvClientMessage(encodeSetBlobResult(kv.id)));
						}
					} else if (frame.kind === "exec") {
						const exec = decodeExecServerMessage(frame.payload);
						if (process.env.CURSOR_SHIM_DEBUG) {
							this.log(`exec case=${exec.case} field=${exec.field} id=${exec.id} tools=${tools.length}`);
						}
						this.#liveness.lastAction = `exec:${exec.case}#${exec.field ?? "?"}`;
						if (exec.case === "requestContextArgs") {
							// Cursor asks for the tool schemas as an exec. Answering on
							// the stream is the only shape the server accepts; a bare
							// top-level push is ignored and the run stalls.
							run.sendToolDefinitions(exec.id, exec.execId, tools);
							continue;
						}
						if (exec.case === "mcpArgs") {
							// The one exec that ends the run. Cursor holds its state
							// server-side, and the next ZCode turn resumes it from the
							// checkpoint with the tool result attached.
							this.#stats.toolRequests += 1;
							toolCall = exec;
							run.end();
							break;
						}
						// Everything else — Cursor's own filesystem and shell tools, and
						// exec variants newer than this build — is refused on its own
						// field number and the run keeps going. Treating them as a tool
						// call instead is what silently disabled tool calling: the model
						// asked, the exec arrived, and the turn ended as a plain `stop`
						// with no tool_calls for the host to run.
						//
						// Bounded, because "refuse and continue" is a loop unless something
						// stops it. A model that keeps re-asking the same refused tool must
						// not burn the user's quota or hold the host's stream open: past
						// the cap the run is ended and reported, never left hanging.
						execs += 1;
						if (execs > MAX_EXECS_PER_RUN || refusals[exec.field] >= MAX_REFUSALS_PER_FIELD) {
							this.log(
								"run did not converge on a tool call",
								`${execs} execs, field ${exec.field} refused ${refusals[exec.field] ?? 0} times`,
							);
							run.end();
							break;
						}
						if (typeof exec.field === "number") {
							refusals[exec.field] = (refusals[exec.field] ?? 0) + 1;
							run.rejectExec(exec.id, exec.execId, exec.field, TOOL_REJECT_REASON);
						}
						continue;
					}
				}
				if (toolCall) break;
			}
		} finally {
			run.close();
		}

		return { text, reasoning, toolCall, completionTokens, promptTokens, checkpoint };
	}

	/**
	 * Anchor the conversation store to what Cursor now holds.
	 *
	 * Without this the store is never populated, so no turn ever resumes and the
	 * resume rate is structurally zero. The anchor is the full message array plus
	 * the checkpoint Cursor just returned; the next request has to be an exact
	 * extension of that array to reuse it.
	 */
	#commit(ctx, result) {
		if (process.env.CURSOR_SHIM_DEBUG) {
			this.log(
				`commit: checkpoint=${result.checkpoint == null ? "none" : result.checkpoint.length + "B"} ` +
					`toolCall=${result.toolCall == null ? "none" : "yes"} messages=${ctx.messages.length}`,
			);
		}
		if (!canAnchorTurn(result)) {
			if (result.toolCall != null) {
				// Paused mid-tool: resuming would drop the tool result ZCode is
				// about to send, so fall back to a textual cold start.
				this.#conversations.forgetPrefix(ctx.messages);
			} else {
				// No checkpoint, so there is nothing to resume from. Do not leave a
				// stale anchor behind.
				this.#conversations.forget(ctx.messages);
			}
			return;
		}
		this.#conversations.record(ctx.messages, ctx.conversationId ?? randomUUID(), {
			checkpoint: result.checkpoint,
			blobs: ctx.blobStore,
		});
	}

	/**
	 * Translate a Cursor exec request into an OpenAI tool call.
	 *
	 * Only calls to tools we registered from ZCode's own list become tool calls.
	 * Cursor's built-in filesystem and shell tools are refused: the host owns
	 * the filesystem and the permission prompts, and a Cursor-side write would
	 * land in Cursor's sandbox rather than the user's workspace.
	 */
	#toToolCall(exec, toolNames) {
		if (!exec || exec.case !== "mcpArgs") return null;
		const { toolName, callId, args } = exec.args ?? {};
		const name = String(toolName ?? "");
		if (!name || !toolNames.has(name)) {
			// A tool Cursor asked for that we never registered. Returning null here
			// silently turns the turn into a plain `stop`, which is precisely how
			// tool calling was invisible for so long. Counting it makes the
			// divergence between what Cursor asked for and what the host received
			// something `cursor_doctor` can report.
			this.#stats.droppedToolCalls += 1;
			this.log("dropped a tool call for an unregistered tool", name || "(no name)");
			return null;
		}
		return {
			id: callId || `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
			type: "function",
			function: { name, arguments: JSON.stringify(args ?? {}) },
		};
	}

	#buildChoice(result, toolNames) {
		const toolCall = this.#toToolCall(result.toolCall, toolNames);
		if (toolCall) {
			this.#stats.toolCalls += 1;
			return {
				message: { role: "assistant", content: result.text || null, tool_calls: [toolCall] },
				finishReason: "tool_calls",
			};
		}
		return { message: { role: "assistant", content: result.text || null }, finishReason: "stop" };
	}

	/**
	 * Report Cursor's own accounting rather than an estimate.
	 *
	 * ZCode derives its compaction threshold from this number, so a guess here
	 * would make it fire at the wrong time. When Cursor tells us nothing we
	 * report zero rather than inventing a figure.
	 */
	#usage(result) {
		const prompt = result.promptTokens ?? 0;
		const completion = result.completionTokens ?? 0;
		return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
	}

	async #stream(response, runRequest, tools, accessToken, ctx) {
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		const base = {
			id: `chatcmpl_${randomUUID().replace(/-/g, "")}`,
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: ctx.model,
		};
		const sendDelta = (delta) =>
			response.write(sseChunk({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }));
		// Open the stream before the run starts so the first byte reaches the host
		// immediately; the role chunk is what most parsers wait for.
		sendDelta({ role: "assistant" });

		let result;
		try {
			result = await this.#collect(runRequest, tools, accessToken, ctx.blobStore, ({ kind, text }) => {
				sendDelta(kind === "text" ? { content: text } : { reasoning_content: text });
			});
		} catch (error) {
			// Several OpenAI-compatible clients only surface a business error from
			// inside a 200 SSE body, so send it that way.
			response.write(
				sseChunk({
					...base,
					error: openAiError(
						String(error?.message ?? error),
						"cursor_error",
						String(error?.code ?? "cursor_error"),
					),
				}),
			);
			response.end(DONE);
			return;
		}

		const { message, finishReason } = this.#buildChoice(result, ctx.toolNames);
		this.#commit(ctx, result);

		if (message.tool_calls) {
			response.write(sseChunk({ ...base, choices: [{ index: 0, delta: { tool_calls: message.tool_calls }, finish_reason: null }] }));
		}
		response.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }));
		// `choices` is required even on a usage-only chunk, or the host's parser
		// rejects the frame and discards the turn's accounting.
		response.write(sseChunk({ ...base, choices: [], usage: this.#usage(result) }));
		response.end(DONE);
	}

	async #complete(response, runRequest, tools, accessToken, ctx) {
		let result;
		try {
			result = await this.#collect(runRequest, tools, accessToken, ctx.blobStore);
		} catch (error) {
			response.writeHead(502, { "content-type": "application/json" });
			response.end(
				JSON.stringify(
					openAiError(
						String(error?.message ?? error),
						"cursor_error",
						String(error?.code ?? "cursor_error"),
					),
				),
			);
			return;
		}
		const { message, finishReason } = this.#buildChoice(result, ctx.toolNames);
		this.#commit(ctx, result);
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				id: `chatcmpl_${randomUUID().replace(/-/g, "")}`,
				object: "chat.completion",
				created: Math.floor(Date.now() / 1000),
				model: ctx.model,
				choices: [{ index: 0, message, finish_reason: finishReason }],
				usage: this.#usage(result),
			}),
		);
	}
}
