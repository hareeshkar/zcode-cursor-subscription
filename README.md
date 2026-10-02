# Cursor Subscription for ZCode

Use your Cursor subscription as a **first-class model provider in [ZCode](https://github.com/zhipuai/zcode)** —
Cursor models appear in the model picker and behave like any other ZCode model: your own tools, your own
permission prompts, ZCode's own context management and compaction.

One command to set it up. Nothing to paste into Settings.

```
/connect-cursor-and-initialize
```

> ⚠️ Cursor's agent protocol is **undocumented and reverse-engineered**. This is a community project and
> may stop working when Cursor changes its servers or client version. Relaying a consumer subscription
> through a third-party client is the activity most likely to trip Cursor's account protections — use it
> for your own local work. Not affiliated with, endorsed by, or supported by Anysphere or Cursor.

---

## Why it is built this way

The obvious way to expose another agent's models is as a *tool*: the agent calls a tool, the tool returns
text. That is also the worst way. Every token would flow through a single tool result — no per-tool
permission prompt, no structured diff, no compaction awareness, and an unbounded context window.

So this is not a tool. It is a provider.

```mermaid
flowchart TB
    subgraph host["ZCode — owns everything"]
        P["Model picker"]
        A["Agent loop"]
        T["Tools + permissions"]
        C["Context + compaction"]
    end
    subgraph plugin["Cursor Subscription plugin"]
        M["MCP tools<br/><i>setup, health, uninstall</i>"]
        S["OpenAI-compatible shim<br/>127.0.0.1:8477"]
    end
    CURSOR["api2.cursor.sh<br/>Connect-RPC + protobuf"]
    P --> A
    A --> C
    A <-- "permission prompt" --> T
    A -- "POST /v1/chat/completions" --> S
    S <--> CURSOR
    M -.->|"setup only, never chat"| S
```

Chat never routes through MCP. The Cursor model is reached over an ordinary OpenAI-compatible HTTP
endpoint, so ZCode's context builder, tool loop and permission system apply to it unchanged.

A Cursor "run" is therefore bounded by one ZCode turn. That is deliberate: **the shim never executes a
tool**, so it cannot bypass a permission prompt.

### One turn, end to end

```mermaid
sequenceDiagram
    participant Z as ZCode
    participant S as Shim
    participant C as Cursor
    Z->>S: POST /v1/chat/completions (messages, tools)
    S->>S: Is this an exact extension<br/>of what Cursor already holds?
    alt exact extension
        S->>C: resume conversation, send only the new turn
    else anything changed
        S->>C: full replay
    end
    C-->>S: streamed deltas
    S-->>Z: SSE content + reasoning
    alt Cursor asks for a tool
        S-->>Z: finish_reason: tool_calls
        Note over Z: ZCode runs the tool,<br/>under its own permission prompt
        Z->>S: next request, with the result
    end
```

### Resume or replay

ZCode rewrites history constantly — auto-compaction, microcompaction, an edit, a branch. Cursor's
server-side conversation cannot be safely resumed across any of those: it would be reasoning about
messages the user can no longer see, with no error anywhere.

So the shim records what it committed to Cursor, and checks every turn whether the incoming history is an
**exact extension** of it.

```mermaid
flowchart TD
    A["New turn arrives"] --> B{"Is the message list an exact<br/>extension of what Cursor<br/>already holds?"}
    B -->|"yes"| C["Resume the server-side conversation,<br/>send only the new turn"]
    B -->|"no — compacted, edited<br/>or branched"| D["Full replay of the<br/>whole history"]
    C --> E["Counted as resumed"]
    D --> F["Counted as replayed"]
```

Because the check covers the *whole prefix*, every operation that rewrites history forces a replay
automatically. The worst case costs exactly what a replay-only design would cost, and never worse.

`cursor_status` reports the **resume rate** — the share of turns that reused Cursor's context. That is
the honest number: Cursor exposes no cache-hit telemetry to third-party clients, so a "cache hit rate"
is not something this plugin can claim.

### Two ZCode sessions, one port

Not an edge case — anyone with two windows hits it at once. Whoever loses the port race does not fail,
and does not start a duplicate shim holding a second copy of your Cursor token.

```mermaid
stateDiagram-v2
    [*] --> TryBind
    TryBind --> Own : bind succeeded,<br/>port recorded
    TryBind --> CheckPeer : EADDRINUSE
    CheckPeer --> Adopt : /health answers<br/>as one of ours
    CheckPeer --> TryBind : not ours —<br/>try the next port
    Adopt --> Watching
    Watching --> Own : peer exited,<br/>take the port over
    Watching --> Adopt : peer still serving
    Own --> [*]
```

`cursor_doctor` probes the socket rather than trusting that decision, so a dead port reads as dead. That
distinction was learned the hard way: an earlier version reported *"Everything checks out"* while nothing
was listening and every completion failed with `fetch failed`.

## Install

This plugin is **not on the official ZCode plugin marketplace.** ZCode's marketplace system takes a
*directory* of plugins, so you clone this repository and register it as your own marketplace. Nothing
is published to a shared registry, and installing makes no network call.

> **Installing with an AI agent?** Hand it [`AGENTS.md`](./AGENTS.md) instead of walking it through by
> hand. That file is written for exactly this: the safety rules an agent must not break (never print a
> credential, never edit ZCode's config, never retry a failed run), the exact clone-and-register steps
> for macOS, Linux and Windows including how to get the absolute path, how to connect safely by adopting
> the existing Cursor session instead of re-authenticating, how to verify, and a failure table where each
> symptom has a different remedy. Ask your agent: *"Read AGENTS.md in this repository and install the
> plugin."*

**Prerequisites**

| | |
|---|---|
| ZCode | 3.14.3 or newer |
| Node | 20 or newer (the plugin uses `node:sqlite` to read Cursor's local session) |
| Cursor | Signed in on this machine — the plugin adopts that session rather than signing in again |
| Git | to clone |

### 1. Clone

```sh
git clone https://github.com/hareeshkar/zcode-cursor-subscription.git
cd zcode-cursor-subscription
```

Keep the folder. It becomes the marketplace ZCode reads from, and it has to stay where you put it.

### 2. Register it as a marketplace

In ZCode: **Plugin Marketplace → Add → Add Plugin Marketplace**, then paste the **absolute path to the
folder you just cloned** — the one containing `marketplace.json`:

```
/absolute/path/to/zcode-cursor-subscription
```

> Paste the folder itself, not the `marketplace.json` inside it, and not the `cursor-subscription`
> subfolder.

It appears under **Your marketplaces**. If the list is empty, the path is wrong — ZCode resolves the
path literally, so a typo fails silently.

### 3. Install the plugin

Open that marketplace and install **Cursor Subscription**. Nothing happens yet: no network call, no
browser, no credential is read. The install just copies files into
`~/.zcode/cli/plugins/cache/`.

### 4. Connect

```
/connect-cursor-and-initialize
```

One call, which:

1. reads the Cursor session from
   `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` and **verifies it against
   Cursor before storing it**
2. sends a real completion on a few cheap models to prove the transport works
3. creates the provider entry in ZCode's config, writing it atomically
4. publishes every model your account can use

It stops and tells you why at any step it cannot complete, without writing a half-configured provider.

### 5. Restart and pick a model

Quit ZCode completely — **⌘Q, not just closing the window** — and reopen it. The model picker reads
the provider config at startup, so the models will not appear until you do.

Then choose any model from the **Cursor Subscription** provider. It behaves like every other model:
your tools, your permission prompts, ZCode's context management.

## Verifying the installation

```
/cursor-status
```

Reports the account, token expiry, the port the shim is serving, and the resume rate. If the shim is
not answering, `cursor_doctor` names the disagreement between the session, the shim and the provider
entry.

## Running it from source

Useful while changing the plugin. The MCP server starts the shim automatically, so this is only for
checking the port and key by hand:

```sh
cd cursor-subscription

# Start the shim standalone. It prints the API key it generated.
CURSOR_SHIM_KEY=some-local-key node scripts/shim.mjs --port 8477

# In another shell:
curl -H "Authorization: Bearer some-local-key" http://127.0.0.1:8477/v1/models
```

Tests — no dependencies, no build step:

```sh
node --test "test/*.test.mjs"
```

After editing the plugin locally, reinstall it from the marketplace (remove, then install again) so
ZCode copies the new files, then restart. There is no hot reload.

## Troubleshooting the install

| Symptom | Cause |
|---|---|
| Marketplace is empty | Wrong path pasted. It must be the folder containing `marketplace.json` |
| `/connect-cursor-and-initialize` is not offered | The plugin was installed in a running session; MCP tools load at startup. Restart ZCode |
| `cursor_import` reports no session | Cursor is installed but not signed in — open Cursor and sign in there, then retry |
| Provider 401 | The API key in ZCode and the shim's key disagree. `cursor_doctor` will say so |
| Connection refused | Nothing is serving the port. `cursor_doctor` reports the actual state rather than guessing |

## What is actually new here

The upstream project this is built on is a working integration for a different host. Turning it into a
ZCode provider was a port, not a copy — and most of the work is the part that is not in the original.

| | |
|---|---|
| **Research** | A cited dossier ([`docs/RESEARCH-FINDINGS.md`](docs/RESEARCH-FINDINGS.md)) reverse-engineering Cursor's protobuf agent protocol, and ZCode's own provider/MCP/streaming contracts, from the source of both |
| **Protocol re-derivation** | Protobuf field numbers, header sets, timing constants and the exec-rejection table verified against a second implementation rather than assumed |
| **Harness-native design** | Choosing a first-class provider over an MCP chat tool, and the resume-vs-replay interlock that makes Cursor's server-side context safe to reuse at all |
| **Onboarding** | A single `cursor_connect_and_initialize` call: adopt, verify, create the provider, publish all models. The model list is written atomically, matched by base URL, and follows the shim if it moves ports |
| **Port robustness** | Recorded port, a bounded fallback scan, health-checked adoption between concurrent ZCode sessions, and takeover when the owning session exits |
| **Diagnostics** | `cursor_doctor` compares session, shim and provider entry and names the disagreement — probing the socket rather than trusting a startup decision |
| **Clean uninstall** | A teardown that removes the credential, the provider, the model rules, the install record, the cache and the data dir, and verifies nothing survived |
| **Review** | An adversarial review pass ([`docs/REVIEW-REPORT.md`](docs/REVIEW-REPORT.md)) that found nine critical defects, ten independently reproduced |
| **Type safety** | The shipped code is type-checked under `strict` with `--noEmit` — no build step, no runtime dependency. CI fails on the null-safety family, which caused three separate defects here; the remaining diagnostics are reported as a burn-down rather than claimed clean |
| **Tests** | 99 unit tests plus live probes that spend a real request: a full tool round trip, agent behaviour across turns (tool choice, mid-session steering, system-prompt retention), and a malformed-input matrix. The live probes are gated behind `CURSOR_LIVE_TESTS=1` and never run in CI |
| **Error taxonomy** | A caller's mistake is a 4xx (`bad_json`, `no_messages`); a shim fault is a 5xx. A client error reported as a server fault sends the host hunting a bug that does not exist |
| **Loop safety** | Refusing an exec and continuing is a loop unless bounded, so a run is capped at 24 execs and 6 refusals of one field, and is then ended and logged rather than left hanging |

Roughly **62% of the shipped code is new**; the derived third is the transport and auth layer listed
per-file in [`NOTICE.md`](cursor-subscription/NOTICE.md).

### Known limits, stated plainly

This ships as usable, not finished. What was verified end to end, and what was not.

**Working, verified with a real agent loop** — tool call emitted, executed for real,
result fed back, model answered:

| Model | Full loop result |
|---|---|
| grok-4.7-medium | answered `port 8080` on turn 2 |
| gemini-3.8-flash-high | answered `port 8080` on turn 2 |
| composer-2.5-fast | answered `port 8080` on turn 2 |
| claude-4.5-sonnet | answered `port 8080` on turn 2 |

- **Server-side conversation reuse.** `cursor_status` reports a real resume rate, and a second turn that
  is an exact extension genuinely resumes. This was believed impossible for most of the project's life
  and was in fact our bug — see the audit.
- **Token accounting.** Usage carries Cursor's own prompt-token count (10,851 on a first turn, 10,952 on
  a resumed second). It reported zero forever before that, which meant the host's compaction threshold
  had nothing real to work from.

**Known limitation: Composer's first turn after a tool result.**

Composer (all tiers tested) sometimes re-issues the same tool call immediately after
the result arrives — once, not indefinitely. The fix that holds for the other three
families (quoting the pending tool results directly into the continuation action)
reduced this for Composer but did not eliminate it: in repeated runs Composer
alternates between answering correctly and re-calling the tool once more before
converging. Grok occasionally reads the text replay of its own tool output as
third-party content and refuses to act on it — the same turn, a different answer,
which is model adherence to a text transcript rather than a transport defect.
Claude and GPT are reliable on this path. ZCode's own loop-round cap is what
bounds the behaviour for every model; the shim cannot and should not loop on the
model's behalf.

**Not working, and stated as such:**

- **Image input.** The shim encodes images exactly as Cursor's own schema declares — payload and
  field-7 tag provably present — but across five models and two kinds of image (synthetic and a real
  screenshot) the model reports receiving none, and then goes hunting with built-in tools. Models are
  advertised as `supportsImage: false` because that was *tested*, not assumed: Cursor's `AvailableModel`
  reports `supports_images` false for every model on the account. The host substitutes placeholder text,
  so the user gets a clear signal instead of a model that flails and stalls.
- **Reasoning level.** Effort is carried in Cursor's model id, not the request — the account exposes
  `-low`/`-high`/`-thinking` variants as distinct models. A selection made in the reasoning picker
  therefore cannot be transmitted, and is reported as an approximation rather than ignored.
- **Parallel tool calls in one turn** are unverified; the run ends at the first call.
- **Cursor's built-in tools are translated, not executed.** When the model calls its native read/grep/
  shell, the shim translates each into the matching ZCode tool call — Read, Grep, Bash — checked against
  the host's own JSON schema, so parameter names are exactly what ZCode declared. ZCode executes under
  its own permission prompts. Deletions have no safe ZCode mapping and are refused with guidance.
- **The harness context is stated in the system prompt.** Every run carries a tool-environment section:
  the harness name, the exact tool list from the host's request, that native Cursor tool names are
  routed automatically, and that dynamic-tool namespaces and XML call formats do not exist here. This is
  what stopped the model declaring tools broken and reaching for refusal workarounds.

Every one of these is reported by the tooling rather than hidden — `cursor_doctor` lists what a session
approximated, and `cursor_status` shows the counters.

### How we know what ran

Every claim above traces to a recorded run, not to a reading of the code. The
evidence chain that made that possible, worth keeping for the next person:

- **`cursor_status` counters** — turns, resumed, replayed, tool requests, tool
  calls delivered, tool calls dropped. A divergence between requested and
  delivered is the signature of tool calling failing, and it is visible without
  running a model.
- **The startup mode line** — every shim prints `history=<mode> client=<version>`
  when it starts, so a recorded result is attributable to the exact path that
  produced it. A result that cannot be attributed is a guess.
- **Byte-level checks** — when a request's behaviour was in question, the encoded
  bytes were decoded and the fields read directly. Two encoder bugs (a nested
  message one level too deep, a dropped tool-call branch) were found that way and
  would have passed any amount of code review.
- **`test/live-structured.mjs`** — the replay matrix, measuring recall of a value
  that exists only in the replayed history. Gated behind `CURSOR_LIVE_TESTS=1`
  because it spends quota; run it before and after any change to the replay path.
- **A stale-process rule** — three separate rounds of testing silently measured a
  pre-fix shim that was still holding port 8477. Check who owns the port, every
  time, before trusting a result.

## Documentation

| Document | What it covers |
|---|---|
| [`docs/CURSOR-PROTOCOL-SCHEMA.md`](docs/CURSOR-PROTOCOL-SCHEMA.md) | **Ground truth.** Cursor's message schemas, extracted from Cursor's own client bundle. Check here first when a field number is in doubt |
| [`docs/CONCEPTS-AND-CONTRACTS.md`](docs/CONCEPTS-AND-CONTRACTS.md) | **Start here.** What a conversation, a resume and a token actually are; Cursor's full field map; what ZCode sends and what happens to it — system prompt composition, steering, compaction, tool results, the streaming contract, cancellation |
| [`docs/HARNESS-AUDIT.md`](docs/HARNESS-AUDIT.md) | The four defects found, the research behind the fixes, and what remains open |
| [`docs/ZCODE-PROVIDER-MAPPING.md`](docs/ZCODE-PROVIDER-MAPPING.md) | How ZCode natively resolves a provider: the closed API enum, the strict config schema, the rule chain, `optionSpecs`, and the absence of model discovery |
| [`docs/RESEARCH-FINDINGS.md`](docs/RESEARCH-FINDINGS.md) | The original cited dossier: protocol reverse-engineering, host contracts, options considered and rejected |
| [`docs/REVIEW-REPORT.md`](docs/REVIEW-REPORT.md) | The adversarial review that shaped the protocol code |

## Repository layout

```
marketplace.json                     the plugin catalogue — add this folder as a marketplace
docs/
  CONCEPTS-AND-CONTRACTS.md          concepts, Cursor field map, ZCode host behaviour
  HARNESS-AUDIT.md                   the four defects, the research, and what is open
  ZCODE-PROVIDER-MAPPING.md          how ZCode natively resolves a provider
  RESEARCH-FINDINGS.md               cited research dossier: protocol, host contracts, options
  REVIEW-REPORT.md                   adversarial review of the protocol implementation
cursor-subscription/
  .zcode-plugin/plugin.json          plugin manifest
  .mcp.json                          MCP server: setup, health and uninstall tools
  commands/                          the slash commands
  lib/                               shim, protocol client, credential store, provider config
  scripts/                           MCP server and standalone shim entry points
  test/                              63 tests, `node --test`
```

## Safety

- Credentials are written `0600` inside a `0700` directory, atomically, with a compare-and-swap so
  concurrent runs cannot clobber each other's token refresh.
- No token ever appears in a tool response, a log line, an error message or a skill.
- The shim binds loopback only and rejects unauthenticated requests in constant time.
- The repository contains no credentials; the ignore rules keep them out.

## Credits

Built on **[dsh-cursor-subscription](https://github.com/orrinzeng/dsh-cursor-subscription)** by
[orrinzeng](https://github.com/orrinzeng) (MIT), which does the same thing for DeepSeek Harness and
which made this port possible. `lib/proto.mjs`, `lib/auth.mjs` and `lib/cursor-client.mjs` are derived
from it; the remaining modules, the research, the host integration and the tooling are new work on top.

Per-file derivations: [`cursor-subscription/NOTICE.md`](cursor-subscription/NOTICE.md).
Licence: [MIT](LICENSE) — see also the notice carried inside the installed plugin.

## Licence

MIT. See [LICENSE](LICENSE).
