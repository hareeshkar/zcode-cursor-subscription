# Cursor Subscription for ZCode — Research Dossier

**Compiled:** 2026-09-28
**Subject:** Porting `dsh-cursor-subscription` (Cursor subscription → DeepSeek Harness) to ZCode
**Local checkouts:** `./dsh-cursor-subscription` @ v0.6.11 · `./ZCode` @ v3.14.3 · `./auth2api-ref`
**Local install inspected:** ZCode Desktop 3.14.3 (`dev.zcode.app`), macOS arm64

This is the reference document for the project. It is written to be re-readable later: every claim
carries a source, and Section 8 records what is *unknown* so a future version does not re-derive it.

---

## 0. Executive summary

1. **Cursor has no official OpenAI-compatible inference API.** Its own docs say the Cloud Agents API and
   SDKs "are not a standalone model-inference or chat-completions API"
   ([cursor.com/docs/api.md](https://cursor.com/docs/api.md)). Official APIs are Enterprise admin/analytics
   or agent orchestration.

2. **Two different reverse-engineered protocols exist.** `agent.v1.AgentService/Run` (full agent loop with
   server-side tool calls, used by the DSH plugin) and `aiserver.v1.ChatService/StreamUnifiedChatWithTools`
   (simple request/response, used by `auth2api`). They are not interchangeable.

3. **Nobody has published a working Cursor → OpenAI tool-calling bridge.** `auth2api` implements the
   ChatService path and contains zero tool-call handling despite the endpoint's name. The DSH plugin is
   the only implementation that bridges Cursor tool calls into a host toolset.

4. **ZCode has no provider-plugin hook.** Plugins contribute skills, commands, agents, hooks, MCP servers,
   LSP servers, output styles, channels. Models reach ZCode only through config-driven providers speaking
   exactly three wire protocols: `anthropic-messages`, `openai-chat-completions`, `openai-responses`.

5. **Therefore the port requires a local translation shim.** ZCode → OpenAI Chat Completions (SSE) →
   shim → Cursor Connect-RPC/protobuf. That is Option B, and it is the only option that yields a real
   coding agent.

6. **V2 has a much better path: ACP.** Cursor CLI speaks the Agent Client Protocol over stdio
   ([cursor.com/docs/cli/acp.md](https://cursor.com/docs/cli/acp.md)), and ACP is a published standard
   ([agentclientprotocol.com](https://agentclientprotocol.com/llms.txt)). ZCode **retired its ACP client**
   in favour of its own native protocol v4, so this is not available today — but it is the correct long-term
   architecture and removes all reverse engineering. See Section 7.

---

## 1. Citation index

| # | Source | Used for |
|---|---|---|
| C1 | [cursor.com/docs/api.md](https://cursor.com/docs/api.md) | Official API surface, auth, rate limits |
| C2 | [cursor.com/docs/llms.txt](https://cursor.com/docs/llms.txt) | Full docs sitemap |
| C3 | [cursor.com/docs/cli/reference/authentication.md](https://cursor.com/docs/cli/reference/authentication.md) | CLI auth, `CURSOR_API_KEY` |
| C4 | [cursor.com/docs/cli/acp.md](https://cursor.com/docs/cli/acp.md) | **ACP support in Cursor CLI** |
| C5 | [cursor.com/docs/cli/headless.md](https://cursor.com/docs/cli/headless.md) | `agent -p --force` scripting |
| C6 | [cursor.com/docs/mcp.md](https://cursor.com/docs/mcp.md) | MCP transports, MCP Apps |
| C7 | [cursor.com/docs/skills.md](https://cursor.com/docs/skills.md) | Agent Skills standard |
| C8 | [cursor.com/docs/subagents.md](https://cursor.com/docs/subagents.md) | Subagent model |
| C9 | [cursor.com/docs/cloud-agent/api/endpoints.md](https://cursor.com/docs/cloud-agent/api/endpoints.md) | Cloud Agents API endpoints |
| C10 | [agentclientprotocol.com/llms.txt](https://agentclientprotocol.com/llms.txt) | ACP v1 + v2 spec index |
| C11 | [github.com/orrinzeng/dsh-cursor-subscription](https://github.com/orrinzeng/dsh-cursor-subscription) | The plugin being ported (MIT) |
| C12 | [github.com/AmazingAng/auth2api](https://github.com/AmazingAng/auth2api) | Reference Cursor→OpenAI bridge |
| C13 | [github.com/zai-org/ZCode](https://github.com/zai-org/ZCode) | ZCode monorepo (Apache-2.0) |
| C14 | Local: `/Applications/ZCode.app` | Installed ZCode Desktop 3.14.3 |
| C15 | Local: `~/.zcode/v2/` | ZCode runtime state |
| C16 | [github.com/ephraimduncan/opencode-cursor](https://github.com/ephraimduncan/opencode-cursor) | Another Cursor→opencode bridge |
| C17 | [github.com/burpheart/cursor-tap](https://github.com/burpheart/cursor-tap) | MITM proxy for Cursor traffic |
| C18 | [github.com/wener/notes](https://github.com/wener/wener) `notes/ai/agent/cursor.md` | Cursor host/endpoint matrix |

---

## 2. Part A — Cursor

### 2.1 What Cursor officially offers (C1)

From the API overview table, verbatim:

| API | Availability |
|---|---|
| Admin API | Enterprise teams |
| Analytics API | Enterprise teams |
| AI Code Tracking API | Enterprise teams |
| Bugbot API | Enterprise teams |
| Cloud Agents API | **Beta (All Plans)** |
| Origin API | Early Beta |
| TypeScript SDK | All users |
| Python SDK | All users |
| SDK Bridge | All users |

The decisive sentence (C1):

> "The Cloud Agents API and SDKs run Cursor agent workflows (workspace context, tools, commands, and
> edits). **They are not a standalone model-inference or chat-completions API.**"

**Authentication (C1):**
- Admin / Analytics / AI Code Tracking / Bugbot: HTTP Basic, API key as username, empty password.
- Cloud Agents: Basic **or** Bearer.
- Origin: Bearer via Origin CLI.
- Key format: `crsr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.

**Rate limits (C1):** default 20 req/min. Exceptions: `filtered-usage-events` 60/min,
`set-user-spend-limit` 250/min, analytics 100/min, `conversation-insights` 20/min, per-user 50/min,
Bugbot review 30/min (10/min in dry-run). Over-limit returns HTTP 429 with `Retry-After: 60`.

**Caching (C1):** Analytics and AI Code Tracking support ETags.

### 2.2 Cloud Agents API (C9) — the only non-Enterprise official agent API

Endpoints include: create/list/get an agent, create/list/get/cancel/stream a run, list artifacts,
download an artifact, archive/unarchive an agent, delete agent, worker tokens, list workers, list pools,
claim a pending request, create a session token, API key info, **list models**, list GitHub repositories,
plus webhooks.

This is *agent orchestration with its own sandbox and billing*, not model inference. Using it to power a
ZCode session would mean giving a remote Cursor agent control of a remote workspace — a different product
from "use my Cursor subscription in my local editor". It is a legitimate but **very different** V3 idea
worth documenting, not a V1 substitute.

### 2.3 The Cursor CLI (C3, C5)

`agent` is a first-class CLI with a browser login flow and an API-key flow:

```bash
agent login                       # browser flow; NO_OPEN_BROWSER=1 prints URL
agent status
agent logout
CURSOR_API_KEY=... agent "..."     # env var
agent --api-key ... "..."
```

Headless/print mode (C5):

```bash
agent -p --force "Refactor this code"     # --force permits file modifications
agent -p "Add JSDoc"                      # without --force, changes are only proposed
```

**This is important for V1 as a fallback**: `agent -p --force` gives a working Cursor coding agent today
without any protocol work. It is a subprocess with text in / text out, so it cannot be a native model
provider — but it is a credible degraded mode, and it is a supported, documented interface rather than a
reverse-engineered one.

### 2.4 ACP — the strategically important find (C4, C10)

Cursor CLI supports the **Agent Client Protocol**:

```bash
agent acp
```

- Transport: `stdio`
- Envelope: **JSON-RPC 2.0**, newline-delimited
- Client → agent on stdin; agent → client on stdout; logs on stderr
- Auth method advertised: `cursor_login`
- Pre-auth via `agent login`, `--api-key`/`CURSOR_API_KEY`, `--auth-token`/`CURSOR_AUTH_TOKEN`
- Endpoint override: `agent -e https://api2.cursor.sh acp`

Session flow (C4):
1. `initialize`
2. `authenticate` with `methodId: "cursor_login"`
3. `session/new` (or `session/load`)
4. `session/prompt`
5. `session/update` notifications while streaming
6. `session/request_permission` → return a decision
7. optionally `session/cancel`

ACP (C10) is a real published standard with a **v2** already specified, covering initialization,
authentication, session setup/list/delete, prompt turns, content blocks, tool calls, elicitation, file
system access, cancellation, terminals, agent plan, session modes, slash commands and extensibility.

**Why this matters enormously:** ACP is precisely the shape ZCode wants (tool calls, permissions,
sessions, streaming, filesystem, terminals). A V2 built on `agent acp` would need **zero reverse
engineering**, would track Cursor's protocol changes automatically, and would be defensible.

### 2.5 Reverse-engineered protocol A — `agent.v1.AgentService` (C11)

Base: `https://api2.cursor.sh`

| Path | Type |
|---|---|
| `/agent.v1.AgentService/Run` | Bidirectional streaming agent run |
| `/agent.v1.AgentService/GetUsableModels` | Unary model discovery |
| `/auth/poll` | Login polling (GET) |
| `/auth/exchange_user_api_key` | Token refresh (POST) |

**Transport:** Node `http2`, `POST`, headers:

```
content-type: application/connect+proto
connect-protocol-version: 1
connect-accept-encoding: gzip
te: trailers
x-ghost-mode: true
x-cursor-client-version: cli-2026.02.13-41ac335
x-cursor-client-type: cli
authorization: Bearer <accessToken>
```

Success requires HTTP 200 **and** a `connect+proto` content type.

**Connect framing:** `[1 byte flags][4 bytes big-endian length][payload]`.
Flags: `0b01` gzip-compressed, `0b10` end-stream. Decompressed frames capped at 64 MiB (zip-bomb guard).

**Protobuf:** the DSH plugin ships a 254-line hand-rolled codec (no protobuf runtime dependency) covering
varints, length-delimited fields, fixed64 doubles, nested messages, and `google.protobuf.Value` (the shape
Cursor uses for MCP tool schemas and arguments).

**Message field numbers (from C11 `lib/index.js`):**

Client → server encoders: `UserMessage`, `AssistantMessage`, `AssistantStep`, `AgentTurn`,
`TurnStructure`, `ConversationState`, `RunRequest`, `RunMessage`, `Heartbeat`,
`KvClientMessage`/`SetBlobResult`, `ExecClientMessage` (+ envelope), `McpToolDefinition`,
`RequestContextResult`, `McpResult`, `GetBlobResult`, plus rejection encoders per exec variant.

Server → client decoders:
- `InteractionUpdate`: `text_delta=1`, `thinking_delta=4`, `token_delta=8`, `turn_ended=14`
- `AgentServerMessage`, `KvServerMessage`, `ExecServerMessage` (`EXEC_SPAN_CONTEXT_FIELD = 19`)
- `GetUsableModelsResponse { models = 1 }`

**Tool bridge:** the model runs server-side. DSH's tool definitions are sent to Cursor as
`McpToolDefinition` messages inside `RequestContext`; when Cursor emits an exec request the adapter runs
the matching DSH tool and writes the result back on the same stream.

**The load-bearing idea — `rejectionFor(exec)` (C11 `lib/index.js:3468`):** every known Cursor exec
variant gets an explicit rejection telling the model to use the host's tools instead:

```
readArgs(7) lsArgs(8) grepArgs(5) writeArgs(3) deleteArgs(4) shellArgs(2)
shellStreamArgs(14) backgroundShellSpawnArgs(16) fetchArgs(20) writeShellStdinArgs(23)
diagnosticsArgs(9) recordScreenArgs(21) computerUseArgs(22)
listMcpResourcesExecArgs(17) readMcpResourceExecArgs(18)
```

and an `unknown` case that replies **on the exec's own field number** with a generic error. The source
comment is explicit about why:

> "Cursor adds exec variants without notice (field 36 appeared this cycle). Answer on the exec's own field
> with the generic error shape, so the model learns the tool is unavailable and falls back to the MCP
> tools; live probing shows every coherent reply resumes the run while silence stalls it."

**This is the single most important design lesson from the port.** Silence wedges the run; any coherent
reply resumes it.

**Timing constants (C11):** heartbeat 5 s · stream idle timeout 120 s · progress timeout 60 s · session
checkpoint TTL 30 min · tool-call settle window 500 ms (sibling tool calls land within ~100 ms).

**Runtime settings:** `maxToolRounds` 1–1000 (default 200, ends run with `TOOL_LIMIT`),
`retryCount` 0–10 (default 0), `retryIntervalMs` 0–300000, `retryHttpStatusCodes` default
`408,425,429,500,502,503,504`, `replayHistoryEachStep` default off.

The plugin is candid that retries are unsafe: Cursor's streaming POST cannot prove a failed attempt was
not processed remotely, so a retry can duplicate work and burn quota.

### 2.6 Reverse-engineered protocol B — `aiserver.v1.ChatService` (C12)

Base: `https://api2.cursor.sh`

| Path | Type |
|---|---|
| `/aiserver.v1.ChatService/StreamUnifiedChatWithTools` | Streaming chat |
| `/aiserver.v1.AiService/AvailableModels` | Model list |
| `/oauth/token` | Token refresh (alternative to `exchange_user_api_key`) |

Also seen: `/aiserver.v1.BidiService/BidiAppend`, `/aiserver.v1.DashboardService/GetCurrentPeriodUsage`.

**Request shape** built by `auth2api` — fields 1, 2, 3, 4, 5, 8, 13, 15, 19, 23, 26, 27, 30, 35, 38,
46–49, 51, 53, 54, wrapped in field 1 and Connect-framed. Field 54 = `"agent"`.

**Response parsing is explicitly heuristic.** The source comment reads:

> "Schema observed against api2.cursor.sh: `StreamUnifiedChatResponseWithTools { StreamUnifiedChatResponse
> stream_unified_chat_response = 2 { string text = 1; Reasoning reasoning = 25 { string text = 1; } } }`"

and the extractor does recursive field-walking with `isUtfPrintable()`, `isUuidLike()` and
`looksLikeProtoStart()` heuristics rather than trusting a fixed schema. For "thinking-but-actually-
answering" models it splits on a literal `</think>` marker.

**Critical negative finding:** grepping `auth2api/src/upstream/cursor-api.ts` for
`tool_call|toolCall|tool_calls|functionCall|ToolCall` returns **zero matches**. Its request builder sends
**no tool definitions**. Despite the endpoint being named `…WithTools`, the public implementation is
text-and-reasoning only.

`auth2api` does expose `/v1/chat/completions`, `/v1/responses`, `/v1/models` and `/v1/messages`
(C12 README), so it is a complete, working **Cursor → OpenAI chat** bridge — just not a coding agent.

Its own README is appropriately blunt:

> "**Note on Cursor:** the cursor provider is a research-only integration built from non-public,
> reverse-engineered Cursor APIs (`api2.cursor.sh` over HTTP/2, Connect-RPC + protobuf). It may break when
> Cursor changes client versions, may violate Cursor's terms, and should be used only for local personal
> experiments."

### 2.7 Request-integrity header: `x-cursor-checksum` (C12)

`auth2api` sends a header the DSH plugin does not:

```
x-cursor-checksum = jyhEncode(transformedTimestampBytes) + stableMachineId
```

- `timestamp = floor(Date.now() / 1_000_000)` — microsecond clock, not seconds
- 6 bytes; `buf[i] = ((buf[i] ^ prev) + (i % 256)) & 0xff` chained from `prev = 165`
- encoded with URL-safe base64 over the alphabet `A–Z a–z 0–9 - _` (note `-`/`_`, not `+`/`/`)
- suffixed with a stable machine id, defaulting to `sha256(token + "machineId")`

Source comment: *"Jyh cipher used by Cursor's desktop client; see cursor_api_demo TASK-18. We replicate it
byte-for-byte so api2.cursor.sh accepts our checksum."*

The DSH plugin sends **no checksum** and works on the `agent.v1` path, so it is evidently not strictly
required there. It is cheap insurance and worth carrying.

### 2.8 Header comparison

```
DSH agent.v1 (C11)                auth2api ChatService (C12)
  content-type: application/connect+proto   Content-Type: application/connect+proto
  connect-protocol-version: 1               Accept: application/connect+proto
  connect-accept-encoding: gzip             User-Agent: connect-es/1.6.1
  te: trailers                              x-cursor-checksum
  x-ghost-mode: true                        x-cursor-client-version
  x-cursor-client-version                    x-cursor-client-type
  x-cursor-client-type: cli                 x-cursor-client-os
                                            x-cursor-client-arch
                                            x-cursor-client-device-type
                                            x-cursor-config-version
                                            x-cursor-timezone
```

### 2.9 Authentication flows

**PKCE deep-link flow (C11, C12) — no callback port required:**

```
1. verifier  = base64url(96 random bytes)
   challenge = base64url(SHA-256(verifier))
   uuid      = randomUUID()

2. Open https://cursor.com/loginDeepControl?challenge=…&uuid=…&mode=login&redirectTarget=cli
   (user clicks "Yes, Log In")

3. Poll 150 times, 1s → 10s backoff (~2.5 min):
   GET https://api2.cursor.sh/auth/poll?uuid=…&verifier=…
     404 → not ready, keep polling
     200 → { accessToken, refreshToken }
```

`auth2api` additionally offers `--cursor-import-local` / `--cursor-storage=…` to pull an existing token
out of a local Cursor desktop install instead of using the browser flow (C12 README) — useful because it
sidesteps browser login entirely for users who already have Cursor installed.

**Refresh:**
```
POST https://api2.cursor.sh/auth/exchange_user_api_key
Authorization: Bearer <refreshToken>
body: {}
→ { accessToken, refreshToken }
```
An alternative `POST https://api2.cursor.sh/oauth/token` also circulates in the community.

Tokens are JWTs; expiry comes from the `exp` claim. `getTokenSub()` decodes `sub` and strips the
identity-provider prefix (`github|user_…` → `user_…`), which is what the dashboard cookie and
`/api/usage?user=` expect.

### 2.10 Usage endpoints (C11)

Read from `https://cursor.com` authenticated by **session cookie** (not the bearer token):

```
/api/usage
/api/usage-summary
/api/dashboard/teams
/api/dashboard/get-aggregated-usage-events
```

Cached 60 s; per-model rows capped at 20. `aiserver.v1.DashboardService/GetCurrentPeriodUsage` is an
alternative seen in `LobsterBoard`.

### 2.11 Host and endpoint matrix (C18)

Egress is not a single host:

```
api2.cursor.sh                        main API
api3.cursor.sh                        Cursor Tab
api4.cursor.sh                        geo-routed Cursor Tab
repo42.cursor.sh
us-asia.gcpp.cursor.sh                geo PoPs
us-eu.gcpp.cursor.sh
us-only.gcpp.cursor.sh
agent.api5.cursor.sh                  agent hosts
agentn.api5.cursor.sh
agent-gcpp-uswest.api5.cursor.sh      agentn-gcpp-uswest.api5.cursor.sh
agent-gcpp-eucentral.api5.cursor.sh   agentn-gcpp-eucentral.api5.cursor.sh
agent-gcpp-apsoutheast.api5.cursor.sh agentn-gcpp-apsoutheast.api5.cursor.sh
```

C11 notes the agent protocol is **not** served on the `agent.api5` hosts.

### 2.12 Community tooling (essential for debugging)

- **`cursor-tap` (C17)** — MITM proxy that sits between Cursor and `api2.cursor.sh` and decrypts TLS with a
  self-signed CA. This is how field numbers get verified instead of guessed.
- **`claude-tap`** — transcript-only; watches `~/.cursor/projects/*/agent-transcripts/*.jsonl`. No MITM.
- **Cursor agent transcripts** at `~/.cursor/projects/*/agent-transcripts/*.jsonl` are a free, reliable
  source of ground-truth request/response JSON.
- **`wisdgod/cursor-rp`** — a DNS/hosts redirector for the whole host matrix above, useful for pointing a
  real Cursor install at a local server.
- **`opencode-cursor` (C16)**, **`opencode-cursor-auth`**, **`Cometix-Tab`**, **`xllm-go/bypass`** — further
  independent Cursor protocol implementations, useful as cross-references when field numbers disagree.

### 2.13 Cursor's own extensibility (C6, C7, C8)

Cursor supports **plugins, skills, subagents, hooks and MCP** — conceptually the same surface ZCode
exposes. MCP support (C6) covers stdio / SSE / Streamable HTTP transports, tools, prompts, resources,
roots, elicitation, and the **MCP Apps** extension (interactive UI returned from tools, with progressive
enhancement). Agent Skills (C7) is an open standard — *"Portable… Version-controlled… Actionable…
Progressive"*.

This is a genuinely good sign for a community plugin: a ZCode-side plugin could plausibly be packaged for
Cursor too, since both hosts speak skills/plugins/MCP.

---

## 3. Part B — ZCode

### 3.1 Local install (C14)

ZCode Desktop **3.14.3** (build 3.14.3.7762), bundle `dev.zcode.app`, Electron, macOS 15.5 SDK, arm64.

```
/Applications/ZCode.app/Contents/
  MacOS/ZCode                      52 KB launcher
  Resources/app.asar              327 MB  (SHA-256 in Info.plist, ElectronAsarIntegrity)
  Resources/app.asar.unpacked/     node-pty, ssh2 native modules
  Resources/glm/zcode.cjs         bundled agent runtime
  Resources/glm/packages/         14 bundled plugins
  Resources/config/               default.json, provider/zcode-builtin.json
  Resources/tools/                 bfs, ripgrep, ugrep
```

**Bundled plugins** (`Resources/glm/packages/`): android-emulator, browser-use, computer-use, documents,
image-search, ios-simulator, node-repl-host, pdf, presentations, plugin-creator, restore-legacy-sessions,
skill-creator, spreadsheets, zcode-guide.

### 3.2 Runtime state (C15)

```
~/.zcode/v2/
  credentials.json          oauth:zai:access_token, zcodejwttoken, oauth:active_provider,
                            account-provider:coding-plan:account:<uuid>:api-key
  provider_config.json      schemaVersion, providerConfigRules, modelConfigRules
  setting.json  bot-config.v3.json  agents-state.json  onboarding-record.json
  telemetry-state.json
~/.zcode/cli/               config.json, plugins/cache/, plugin-workspace/
~/.zcode/workspace/
```

Credential keys are namespaced by kind and provider. *(Values are present in the live file and were
deliberately not read or recorded.)*

### 3.3 What a ZCode plugin may declare

From `PluginManifest` in `apps/zcode-cli/packages/contracts/src/plugins/index.ts:141` (C13):

```ts
agents?, author?, channels?, commands?, dependencies?, description?, homepage?,
hooks?, keywords?, license?, lspServers?, mcpServers?, name, outputStyles?,
repository?, settings?, skills?, userConfig?, version?
```

**There is no provider, model, or LLM entry.** Grepping
`apps/zcode-cli/packages/adapters/src/plugins/index.ts` for `provider` returns nothing.

Real bundled example — `ios-simulator-plugin/.zcode-plugin/plugin.json`:

```json
{
  "name": "ios-simulator",
  "version": "0.1.0",
  "skills": "skills",
  "commands": "commands",
  "mcpServers": {
    "ios-simulator": {
      "command": "node",
      "args": ["${ZCODE_PLUGIN_ROOT}/dist/mcp/server.js"],
      "cwd": "${ZCODE_PROJECT_DIR}",
      "env": {
        "IOS_SIM_PLUGIN_DATA": "${ZCODE_PLUGIN_DATA}",
        "IOS_SIM_DEFAULT_DEVICE": "${user_config.default_device}"
      }
    }
  },
  "userConfig": {
    "default_device": { "type": "string", "default": "iPhone 16", "description": "…" }
  }
}
```

Note the substitution tokens available to plugins: `${ZCODE_PLUGIN_ROOT}`, `${ZCODE_PLUGIN_DATA}`,
`${ZCODE_PROJECT_DIR}`, `${user_config.<key>}`, and `${ZCODE_BASE_URL}`.

### 3.4 The provider system — the binding constraint

Providers are **config, not plugins**. `packages/provider/src/config/provider-data-schema.ts`:

```ts
export const providerApiTypeDataSchema = z.enum([
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
]);
```

Each provider carries:

```ts
api:  { type, baseUrl, headers? }
access: { type: "api-key" | "zhipu-coding-plan-api-key", apiKey, apiKeyManagementUrl? }
group, logo, builtinModelIds, personalModelIds, modelOrder, visibility
```

Custom `baseUrl` is explicitly supported — `personalProviderApiDataSchema` relaxes it to
`z.string().nullable().optional()` with the comment *"Personal 允许暂存编辑中的 endpoint"*. There is a real
add-provider UI at `packages/ui/src/settings/ModelProviderSection.tsx`.

**This is the crux of the whole port.** ZCode can speak three well-known API shapes. Cursor's Agent
service is protobuf over bidirectional HTTP/2. No configuration bridges that; something must translate.

### 3.5 What ZCode handles for free

`apps/zcode-cli/packages/adapters/src/model/model-execution.ts` implements:
SSE parsing with `event:` frames, incremental UTF-8 decoding, **HTTP 200 SSE error frames** (some
OpenAI-compatible providers report business errors that way), and standard OpenAI function calling.

So a shim only has to speak ordinary OpenAI Chat Completions — ZCode does the rest.

### 3.6 ACP was retired from ZCode

ZCode previously implemented ACP. It is gone:

- `packages/services/test/nonCliAcpRetirement.test.ts`
- `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts:2644` —
  `// legacy ACP 下线后 scanImportableClaudeSessions 被留成空桩，迁移向导扫不到 ~/.claude/projects。`
- `packages/services/src/storage/domain/storageCatalog.ts` still reserves `v2/acp-auth`, `v2/acp-config`,
  `v2/acp-traffic-proxy`, `v2/acp-stream-diagnostics`
- `packages/desktop/src/main/exportLogs.ts:132-135` still lists the same four log channels
- A `restore-legacy-sessions-plugin` exists to migrate "legacy ACP-era ZCode sessions"

ZCode replaced ACP with its own **native protocol v4** (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/`,
~40 modules covering projections, replay, compaction, telemetry and session indexing).

**Consequence:** the ACP path that would have been the easy V2 is not available in ZCode today. A ZCode
plugin cannot register as an ACP client. The directories are residual.

---

## 4. Part C — The gap

| Capability | DSH plugin (C11) | ZCode (C13) | Portable? |
|---|---|---|---|
| Register a model provider | ✅ `inject: ["llm"]` | ❌ config only, 3 fixed shapes | ❌ needs shim |
| Appear in model picker | ✅ provider route | ⚠️ as a configured provider | ⚠️ via shim |
| Credential store | ✅ `inject: ["credentials"]` | ⚠️ internal; plugin gets `${ZCODE_PLUGIN_DATA}` | ✅ file store |
| Settings UI panel | ✅ React in DSH settings | ❌ no plugin-injected settings UI | ❌ → MCP tools + commands |
| Loopback host RPC | ✅ `inject: ["connection"]` | ❌ not exposed | ❌ → local HTTP |
| MCP server | n/a | ✅ first-class | ✅ |
| Skill / command / agent | n/a | ✅ first-class | ✅ |
| Hooks | n/a | ✅ first-class | ✅ |

The two structural losses are **provider registration** and the **settings panel**. Everything else maps.

---

## 5. Part D — Options

### Option B — OpenAI-compatible shim on `agent.v1` **(chosen for V1)**

```
ZCode ──POST /v1/chat/completions (SSE, tools[])──▶ shim ──HTTP/2 Connect+protobuf──▶ api2.cursor.sh
```

| OpenAI side | Cursor side |
|---|---|
| `tools[]` | `McpToolDefinition` set in `RequestContextResult` |
| `messages[]` | `ConversationState` (turns → `UserMessage`/`AssistantMessage`/`AssistantStep`) |
| SSE `content` delta | `InteractionUpdate.text_delta` (field 1) |
| SSE reasoning delta | `InteractionUpdate.thinking_delta` (field 4) |
| `finish_reason: "tool_calls"` | Cursor exec request → OpenAI `tool_calls[]` |
| next-turn `tool` messages | tool result folded into replayed conversation state |

**Key simplification:** ZCode is strictly request/response — it cannot answer mid-stream. So the shim
buffers: when Cursor asks for a tool, it ends the Cursor run and returns an OpenAI response with
`finish_reason: "tool_calls"`. ZCode executes the tool and sends the next request; the shim replays the
conversation. This is exactly `replayHistoryEachStep = true` semantics, and it is the honest mapping
because ZCode already resends full history every turn.

This design **eliminates the bidirectional exec-response machinery entirely**. Only the exec *detection*
and *field-number rejection* logic from `rejectionFor()` needs porting.

- **Gains:** Cursor models appear **natively in ZCode's model picker**; ZCode's tools, permissions,
  sessions, compaction, telemetry and context all work normally.
- **Cost:** the tool-name mapping and unknown-field rejection must be re-derived against ZCode's tool set.

### Option C — ChatService shim, no tools
Hours of work. Cursor answers with text and reasoning. Proves ZCode provider registration end-to-end, but
with no tool calls it is a chat model, not a coding agent.

### Option D — Depend on `auth2api` (C12)
Zero protocol work; a Cursor provider today. But it is a third-party proxy, it has no tools, and it is
itself described as research-only. Good as a **validation harness** for the ZCode side, not as the artifact.

### Option A — MCP tool server
Small and honest, but Cursor's file edits land in Cursor's sandbox rather than ZCode's workspace and
ZCode's permission system is bypassed. Its code (auth, proto, framing) is ~100% shared with Option B, so
it is a cheap fallback if the bridge proves intractable.

### Option E — Subprocess bridge on `agent -p --force` (C5)
Wrap Cursor's documented CLI. No reverse engineering at all, and file edits land on the real filesystem.
But it is text-in/text-out, so it cannot be a native provider either — it is an MCP-shaped tool
(`cursor_agent(task) -> text`), i.e. Option A with a much safer and more future-proof backend.

---

## 6. Chosen plan (V1) — harness-native

**Design principle: the plugin adds a *model*, not a *tool*.** Nothing Cursor does should arrive as an
opaque blob in a tool result. The Cursor model becomes a first-class ZCode provider, so ZCode's own
context builder, tool implementations, permission prompts, compaction, telemetry and session store all
apply to it unchanged. A tool-call result is a normal ZCode tool result — a diff, a file listing, command
output — summarised by ZCode's own machinery, exactly as if the user had picked the model by hand.

This is the whole reason to build the shim rather than an MCP server. An MCP `cursor_chat` tool forces
every token Cursor produces through one tool result: no per-tool permission prompt, no structured diff,
no compaction awareness, no telemetry, and a context window that grows without bound.

### 6.1 Token-efficient conversation reuse (the key design decision)

ZCode is strictly request/response — it resends the entire message history on every turn. If the shim
replayed all of that into Cursor each time, cost would be O(history) per step, which is exactly the
waste we are trying to avoid.

Instead the shim keeps a **conversation store** and resumes server-side:

```
request messages  ──▶  hash the message prefix
                        │
                        ├─ prefix-hash hits a live Cursor conversation
                        │     → send ONLY the new messages, reusing conversationId
                        │     → Cursor continues its own server-side context
                        │
                        └─ miss (new session / restart / >30 min idle)
                              → full replay once, then cache the conversationId
```

- **Steady-state cost is O(new tokens) per turn**, not O(history).
- The prefix hash is content-derived, so it needs no cooperation from ZCode and survives restarts.
- Entries expire on a TTL (30 min, matching the session-state TTL in C11) and on an explicit reset.
- Falls back to replay automatically, so a lost Cursor conversation degrades cost, never correctness.

`replayHistoryEachStep` from C11 is therefore the **fallback**, not the default — the inverse of the
DSH plugin's own default, and the right choice for a host that already resends history.

### 6.2 Stage 0 — validate the ZCode side cheaply

Register a personal provider against a stub returning canned SSE. Confirms picker population, streaming,
and the tool-call round trip. All remaining risk is then confined to the Cursor protocol, which is the
part best understood. Do this before writing any Cursor code.

### 6.3 Stage 1 — the shared layer

`proto.mjs` (protobuf + Connect framing, ported from C11) · `credentials.mjs` · `auth.mjs`
(PKCE, poll, refresh) · `cursor-client.mjs` (`agent.v1` run, `GetUsableModels`, usage) ·
`conversation-store.mjs` (the prefix-hash resume described above) · ported unit tests
(proto framing, image input, native fetch, version parsing).

### 6.4 Stage 2 — the shim

OpenAI Chat Completions in, Cursor out, SSE out. Tool definitions are forwarded to Cursor as
`McpToolDefinition`s so Cursor calls *ZCode's* tools; exec requests map back to ZCode tool calls;
unknown Cursor exec variants are rejected **on their own field number** so the run always resumes.
`token_delta` (field 8) is surfaced as OpenAI `usage` so ZCode's compaction has a real anchor.

### 6.5 Stage 3 — packaging

MCP management surface (`cursor_login`, `cursor_status`, `cursor_logout`, `cursor_models`,
`cursor_usage`) — note these are *management* tools only; chat never routes through MCP. Plus a skill, a
`/cursor-usage` command, and the dev marketplace entry.

### 6.7 Cache-hit fundamentals (researched, not assumed)

**Server-native resumption beats prompt caching.** Re-sending a prefix and reading it from a cache still
costs the full read. Resuming a server-side conversation costs *only the new tokens*. This is why §6.1
is the primary lever and `cache_control` is secondary — not the other way round.

**Cursor's protocol has no cache-control primitive at all.** Verified against the encoders in C11:
`AgentRunRequest` carries only `conversation_state=1`, `action=2`, `model_details=3`, `conversation_id=5`;
`ConversationState` carries only `root_prompt_messages_json=1` and `turns=8`; `RequestContextResult`
carries only `RequestContext.tools=7`. There is no cache field, no breakpoint, no TTL anywhere in the
request path. **Any caching Cursor benefits from is implicit and server-side.** The only resumption lever
a client controls is `conversation_id=5`.

That Cursor's *usage dashboard* reports `cacheWriteTokens` / `cacheReadTokens` (C11 `lib/index.js:2490`)
shows the underlying vendors do cache, and Cursor benefits — but the benefit accrues to Cursor's server,
not to a third-party client sending an explicit marker.

**ZCode's `cache_control` is Anthropic-namespaced only.** `providerOptionsForCacheControl()`
(`apps/zcode-cli/packages/adapters/src/model/transform.ts:499`) returns:

```ts
{ providerOptions: { anthropic: { cacheControl: { ...cacheControl } } } }
```

Hardcoded to the `anthropic` namespace. For an `openai-chat-completions` provider — which is what our shim
is — this is a no-op, and ZCode falls back to the provider's automatic prefix caching. **That is the
correct behaviour for us, not a limitation to work around**, because automatic prefix caching is what
OpenAI-compatible providers actually honour.

**Consequence: the cache strategy reduces to exactly two mechanisms, and only the first is ours to drive.**

| | Mechanism | Who controls it |
|---|---|---|
| Primary | `conversation_id=5` server-native resumption | **Us** — costs zero prefix tokens |
| Secondary | automatic prefix caching on the replay path | Cursor, but only if our prefix is stable |
| Not available | explicit `cache_control` breakpoints | Neither — no field in the protocol |

**Cache-hit design rules for the shim:**

1. **Resume, never replay, in steady state.** Send `conversation_id` and only the new turns.
2. **Never inject per-request values into the replayed region.** No timestamps, no request ids, no
   re-serialisation differences. A single varying byte in the prefix invalidates every cache downstream.
3. **Serialise deterministically** — same messages in, byte-identical bytes out, every time.
4. **Report truthful usage** from `ConversationStateStructure.token_details.used_tokens` (field 8
   `token_delta` / `decodeCheckpointUsedTokens`), so ZCode's compaction threshold is not computed from a
   fiction.
5. **Do not send `cache_control`.** ZCode will not for this provider type, and the protocol has nowhere
   to put it. Emitting a marker that goes nowhere is worse than emitting none.

**The honest framing for users:** Cursor does not expose cache-hit telemetry to third-party clients, so
the shim cannot *report* a cache-hit rate — it can only *achieve* one. What is measurable is the shim's own
resume rate (how many turns reused a live `conversation_id` instead of replaying), and that is the number
worth surfacing.

### 6.9 The resumption correctness problem, and how the design resolves it

A naive reading of §6.1 says "keep a server-side Cursor conversation and send only new turns". That is
wrong, and the reason is worth stating because it is the difference between a working plugin and a
plausible one that silently corrupts sessions.

**The problem: ZCode owns the source of truth for context, and it mutates it.**

ZCode rewrites the message array between turns in several ordinary ways:

- **Auto-compaction** replaces a span of history with a summary.
- **Microcompaction** trims individual content blocks.
- **Regenerate / edit / branch** rewrites a turn and everything after it.
- Tool results are normalized, filtered and media-projected.

If the shim resumes a Cursor conversation that was anchored to the *pre-compaction* history, Cursor keeps
reasoning about messages the user can no longer see. There is no error, no failed request — just a model
confidently answering from a conversation that does not exist on the client. That is the worst possible
failure mode: silent and plausible.

**Why resumption is still right.** The cost argument is real, and C11 supplies empirical evidence that
Cursor's own agent loop re-derives context per step and behaves correctly while doing so:

> "A plugin whose transport re-sends its own message history — as the standard function-calling ones do —
> hands the model the same explicit history at every step. Delegating that history to Cursor's server
> instead is what a Cursor turn was observed to re-derive from: the step re-stated its goal, re-read its
> goal and rewrote its plan while its tool calls kept succeeding." (C11 `lib/index.js:187`)

So Cursor tolerates both. The question is only how we decide which to use.

**Resolution: the prefix hash is a correctness interlock, not a cache key.**

The shim records the exact message sequence it has *successfully committed to Cursor*. On the next
request it hashes ZCode's incoming messages and compares against that record:

```
ZCode messages ──▶ is it an exact extension of what Cursor holds?
                    │
                    ├─ yes → send only the suffix + conversation_id   (O(new tokens))
                    └─ no  → full replay, re-anchor the conversation (O(history))
```

This is the whole safety argument. Because the check is against the *full* prefix rather than a
timestamp or a session id, every operation that rewrites history — compaction, microcompaction,
regenerate, branch — automatically forces a replay. We never need to enumerate ZCode's mutation paths,
because we detect the mutation rather than model it.

The properties that fall out:

- **Safe by construction.** Any divergence replays. We cannot be wrong about stale state, only slow.
- **Degrades to the naive design.** Worst case (every turn diverges) the shim costs exactly what a
  replay-only design costs. There is no scenario where it is worse.
- **Cheap.** Hashing a few hundred KB of JSON per turn is microseconds and entirely local.
- **Divergence is the normal case after compaction**, and that is fine — compaction is exactly when you
  *want* to pay the replay cost, because the whole point is that the context shrank.

This is the single most important design decision in the port, and it is the one most likely to be got
wrong by copying C11's `replayHistoryEachStep` flag literally.

### 6.10 A ZCode turn is not a Cursor run

ZCode is strictly request/response: it cannot answer a tool call mid-stream. Cursor's model runs
server-side and expects a client response *on the open stream*. These do not fit.

The resolution: when Cursor emits an exec request, the shim **ends that Cursor run** and returns
`finish_reason: "tool_calls"` to ZCode. ZCode executes the tool and issues a new request; the shim
resumes the same `conversation_id`.

Two consequences worth being explicit about:

1. **A tool step costs a new Cursor run.** With resumption that is cheap (§6.9), but it is a real cost
   and belongs in the token accounting rather than being hidden.
2. **The DSH plugin's bidirectional machinery is not needed.** We port exec *detection* and the
   field-number rejection table, not the exec-response write path. That is a large simplification and it
   is what makes this tractable.

### 6.11 What the shim must *not* do

The tempting mistake is to treat the shim as a second context manager — adding its own compaction,
summarisation, or message pruning on top of ZCode's.

**It must not.** ZCode already has auto-compaction, microcompaction, TTFT clocks and a tuned context
builder. A second manager operating on the same messages would fight it, and the failure would be
subtle: correct-looking behaviour that silently diverges from what the user sees, and a compaction
decision made against numbers the shim invented.

The shim's correct scope is the **boundary**, and it is narrow:

| The shim owns | The shim must not own |
|---|---|
| Token-accurate `usage` reporting | Compaction policy |
| Resuming vs replaying the prefix | Summarisation or pruning |
| Stable, deterministic serialisation | Message reordering or rewriting |
| Tool-call translation | Deciding *which* tools the model may use |
| Refusing unsupported Cursor execs | ZCode's permission prompts |

**Being transparent is the feature.** A shim that adds zero tokens of its own, reorders nothing, and
reports honest numbers is strictly better for ZCode's context management than one that tries to help.
The one place we can genuinely improve on the default is token *cost* (§6.9) and token *accuracy*
(§6.7) — and those are exactly the two things the shim is positioned to get right.

### 6.12 Token storage safety

`${ZCODE_PLUGIN_DATA}/credentials.json`, mode `0600`, directory `0700`, written **atomically**
(temp file + `rename`) so a crash cannot truncate a live credential. Refresh-token rotation guarded
exactly as in C11 — overwrite only when the stored refresh token is still the one that was refreshed.
No token ever appears in an MCP tool response, a log line, a skill, or an error message. `getTokenSub()`
is used only to derive the account id, never the token.

**First-run consent.** Because relaying a consumer subscription through a third-party client is the
activity most likely to trip Cursor's account protections (§9), the login tool must state this in plain
language *before* opening the browser, and the plugin must not auto-start any network call on install.

---

### 6.13 The harness requirement (non-negotiable)

**The system prompt *is* the harness.** ZCode does not expose skills, project memory, environment
facts, output style or context-management policy as tools. `context/builder.ts` assembles all of it
into `system` messages, and `system-message-compat.ts` merges leading system messages into **one**
for OpenAI-compatible providers. Verified in `ZCode/apps/zcode-cli/packages/core/src/context/builder.ts`
and `.../adapters/src/model/system-message-compat.ts`.

So the capability surface a Cursor-backed session gets is:

| ZCode capability | How it reaches the Cursor model |
|---|---|
| Tools (read, write, bash, grep, …) | `tools[]` → `McpToolDefinition` → ZCode executes them |
| Permissions | ZCode's own prompt, because ZCode runs the tools |
| Skills, project memory, environment, output style, compaction policy | the `system` message |
| Workflows, commands, subagents | host-side, reached through tools and skills |

**Therefore a provider integration that filters out `system` messages is not harness-native.** It
looks fine — HTTP 200, plausible text — while the model has no skills, no memory and no environment.
The first implementation did exactly this (`if (role === "system") continue`) and it was the worst
bug in the project, because nothing reported it.

Cursor's agent protocol has no system role, so the text is published as a root-prompt blob and served
over the KV handshake. **A regression test asserts the system text survives translation** — that is
the guard, not a code comment.

### 6.14 What live testing against Cursor established

Run against a real account with `composer-2.5`, 2026-09-28. **Confirmed working:**

- **Authentication** — the stored session works as a bearer; no checksum header is needed on `agent.v1`.
- **Model discovery** — `GetUsableModels` returned ~200 models including `composer-2.5`,
  `composer-2.5-fast`, `gpt-5.6-*`, `claude-opus-5-5-*`, `gemini-3.8-flash-*`, `glm-5.3-codex`.
  Our decoder and name-sorting are correct.
- **Request encoding** — the run request serialises to exactly the expected fields `1,2,3,5`.
- **Connect framing over HTTP/2** — frames decode correctly from the real stream.
- **The blob handshake** — Cursor issues `getBlobArgs` for the system-prompt blob, and serving it is
  what unblocks the run. Unserved, Cursor sends nothing but heartbeats indefinitely. **This was the
  single difference between "HTTP 200 with no content" and "the model replies."**

**Still open, and where the Advisor review is aimed:**

- **Exec negotiation.** Once unblocked, Cursor immediately issues an exec request (field 2). The shim
  must decide per exec variant whether it maps to a ZCode tool call or is refused. A refused or
  unmapped exec currently degrades to an empty `finish_reason: "stop"`, which is wrong — it should
  surface as an explicit refusal so the model falls back, per the `rejectionFor()` lesson.
- **Checkpoint capture — DOES NOT HAPPEN.** Across 9 real turns (one manual plus an 8-model
  self-test), `conversations` stayed at **0** and `resumed` at **0**. Cursor never sent an
  `AgentServerMessage` field 3, so no checkpoint is ever captured and the resume path never engages.
  Every turn is a full replay.

  **This means §6.1 and §6.9 describe an architecture that does not work against the current API.**
  The prefix-hash interlock is still correct and still worth keeping as a safety interlock, but it is
  guarding a path that is not currently taken. The honest position:

  - The shim works. It streams, it accounts tokens, it carries the harness system prompt.
  - Context is resent in full on every turn, exactly like any other OpenAI-compatible provider.
  - No token saving from resumption is being realised, and the dossier's cost claims should be read
    as design intent, not as measured behaviour.

  Why is it absent? Unknown. Candidate explanations, none confirmed: Cursor only emits a checkpoint
  once a conversation is long enough to compact; the checkpoint arrives on a later frame than we
  observe; or the field number is different in the current API version. The reference implementation
  (C11) captures one at `lib/index.js:3146-3149` and explicitly *waits* for it after an MCP tool call
  (`:3150-3157`), which suggests it is late- or tool-triggered rather than per-turn. Verifying this
  needs a long multi-tool session, not a single probe.

Two bugs that only a real stream exposed, both invisible to a green suite: the frame reader
concatenated its buffer per chunk (O(n²), OOM at 4 GB), and the poll loop raced `reader.next()`
against a timeout, orphaning a promise on every tick. See [[test-streaming-paths-live]].

## 7. V2 roadmap — what to build next, and why

### V2.1 ACP over `agent acp` (highest value)

Replace the entire protobuf/Connect layer with a JSON-RPC 2.0 client over stdio to Cursor's own CLI (C4).
Benefits: no reverse engineering, no client-version pinning, no checksum, no field-number archaeology,
and it survives Cursor protocol changes because Cursor's own binary tracks them.

**Blocker:** ZCode retired its ACP client (§3.6). Two routes:
1. Contribute ACP back to ZCode as a first-class agent backend — large, but the protocol v4 work shows
   ZCode is willing to own protocol surfaces.
2. Ship the ACP client inside the plugin as a local shim (same architecture as V1, different upstream),
   which keeps the plugin self-contained and gives the community an ACP bridge regardless of host.

Note ACP v2 is already specified (C10) — target v1 first, v2 when Cursor ships it.

### V2.2 Full tool bridge parity

Port the complete `rejectionFor()` matrix and verify against live traffic with `cursor-tap` (C17).
Add multi-step tool bursts using the 500 ms settle window (C11).

### V2.3 Cloud Agents backend (C9)

Offer a second, officially-supported backend for teams: delegate whole tasks to a Cloud Agent instead of
driving a local session. Different product, Enterprise/Beta gated, but it is the *supported* path and
belongs in the plugin as a clearly-labelled alternative.

### V2.4 Multi-account and routing

`auth2api` demonstrates per-account pools with sticky routing, cooldown, failover and per-account usage
tracking. Worth adding once single-account works.

### V2.5 Dual-host packaging

Because Cursor and ZCode share the skills/plugins/MCP/subagents vocabulary (C6, C7, C8), the skill and
command halves of this plugin should be portable to Cursor. Design the skill to be host-agnostic from V1.

### V2.6 Degraded modes

- `agent -p --force` subprocess mode (C5) — safe, supported, no tools, useful when the protocol breaks.
- ChatService mode (C12) — no tools, but a working provider.
- MCP mode (Option A) — Cursor's own sandbox.

Shipping all three turns "the protocol broke" from a total outage into a reduced-capability mode.

---

## 8. Open questions and known unknowns

Recorded so a future version does not re-derive them:

1. **Is the checksum required?** C11 omits `x-cursor-checksum` and works on `agent.v1`; C12 includes it on
   ChatService. Untested whether `agent.v1` tolerates a *wrong* checksum or requires a correct one.
2. **Is `agent.v1` still current?** C11 pins `cli-2026.02.13-41ac335`; C12 pins `cli-2026.01.09-231024f`.
   Two projects disagree about the current client version. Which is right, and does Cursor gate on it?
3. **Does ChatService actually return tool calls?** The endpoint name says so; no public implementation
   parses them. Reading one frame with `cursor-tap` would settle it and could collapse V1's hardest
   component.
4. ~~**Exact `ConversationState` field semantics** for replaying a tool result~~ — **ANSWERED, and it
   invalidates the first implementation.** Two corrections found in C11 while reviewing our own code:

   - **Resumption is checkpoint-based, not `conversation_id`-based.** `AgentServerMessage` field 3 is
     `conversation_checkpoint_update`; the payload *is* the serialized `ConversationState`. C11 stores it
     (`persisted.checkpoint`) and sends it straight back as `conversation_state` on the next run. It
     passes `conversationId: randomUUID()` on **every** request — the id is not the anchor, the checkpoint
     is. Our first implementation anchored on `conversation_id` and never captured a checkpoint, so it
     could not have resumed even in principle.
   - **"Never hand-encode field-8 turns: current Cursor servers treat them as blob ids."** C11
     `buildInitialConversationState` does not write turns at field 8; it writes blob references into
     `root_prompt_messages_json` (field 1) and serves the actual content back to Cursor through the
     blob/KV channel (`GetBlobResult`, `KvClientMessage`, `SetBlobResult`). Our `encodeTurns` wrote field
     8 directly, which a current server would read as a list of blob ids.

   The corrected design is therefore: **cold start builds a blob-backed conversation state; every
   subsequent turn replays the server's checkpoint.** The prefix-hash interlock still applies — it decides
   *whether* the checkpoint we hold still matches ZCode's history — but the payload we send is the
   checkpoint, not a re-encoded turn list. This also means the shim needs a blob store, which the first
   version did not have.
5. **Whether `x-ghost-mode: true` is required** or merely a cloak used by DSH.
6. **Rate limiting and quota behaviour** of `agent.v1` under sustained tool loops. Undocumented.
7. **Whether the Cloud Agents API can be driven statelessly** close enough to a chat completion to be a
   provider (C9). Probably not, but untested.

---

## 9. Legal and ethical notes

- **dsh-cursor-subscription is MIT**; **ZCode is Apache-2.0**. Porting MIT code into an Apache-2.0 project is
  permitted with attribution. A standalone plugin must carry the MIT licence and credit orrinzeng —
  the port must retain the original copyright notice and a NOTICE file.
- **Cursor's Agent protocol is undocumented and reverse-engineered.** Both C11 and C12 say so explicitly
  and warn it may break and may violate Cursor's terms. `auth2api` puts it bluntly: *"should be used only
  for local personal experiments."*
- **Relaying a consumer subscription through a third-party client is exactly the activity most likely to
  trip account restrictions.** This deserves to be stated in the plugin README, in the skill, and in the
  first-run consent text — not buried in a licence file. Anyone shipping this to a community is making a
  statement about acceptable use, and it should be an explicit one.
- **Not affiliated with Anysphere.** Say so plainly in the README.
- Reimplementing protocol details rather than copying them wholesale reduces, but does not eliminate,
  exposure. The MIT attribution obligation applies regardless.
