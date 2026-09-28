---
name: cursor-subscription
description: Use a Cursor subscription as a first-class ZCode model provider. Use when the user wants to sign in to Cursor, check Cursor subscription status or usage, list Cursor models, or troubleshoot a Cursor provider that is not responding. Also triggers on "Cursor models", "Cursor subscription", "use my Cursor plan in ZCode", or "connect Cursor". Cursor models run as a normal ZCode provider, so their tools, permissions and context management are ZCode's own.
---

# Cursor subscription as a ZCode provider

This plugin makes Cursor subscription models appear in ZCode's **model picker** as a normal provider.
Nothing about the chat path is special: ZCode builds the context, ZCode decides which tools to offer,
ZCode shows the permission prompt, ZCode compacts the history, ZCode records the telemetry.

That is the whole point. An alternative design — exposing Cursor as an MCP tool — would force every
token Cursor produces through a single tool result: no per-tool permission prompt, no structured diff,
no compaction awareness, and an unbounded context window.

## Tools

| Tool | Use it for |
|---|---|
| `cursor_login` | First-time sign-in. Opens a browser PKCE flow and stores the token locally. |
| `cursor_status` | Whether Cursor is signed in, when the token expires, and the shim's resume counters. |
| `cursor_logout` | Delete the stored credential. Ask the user first — it cannot be undone. |
| `cursor_models` | List the models the account may use. |

Sign-in needs a human: the tool opens `cursor.com/loginDeepControl` in the user's browser and polls
until they complete it. Call `cursor_login` once and let the user finish in the browser; do not retry in
a loop.

## How a turn actually works

1. ZCode sends an OpenAI Chat Completions request to the local shim.
2. The shim checks whether the conversation is an **exact extension** of what Cursor already holds.
   - Exact extension → resume the server-side conversation, sending only the new turn.
   - Anything else (ZCode compacted, edited, or branched) → full replay.
3. Cursor streams back. The shim maps text to `content` and reasoning to `reasoning_content`.
4. If Cursor asks for a tool, the shim ends the run and returns `finish_reason: "tool_calls"`.
   ZCode executes the tool under its own permission system and sends the next request.

A Cursor "run" is therefore bounded by one ZCode turn. That is deliberate: the shim never executes tools
itself, so it cannot bypass a permission prompt.

## When a Cursor turn is failing

Cursor's agent protocol is undocumented and changes without notice. If chat starts failing:

1. Run `cursor_status`. A `resume rate` far below 1.0 with a rising `replayed` count usually means ZCode
   is compacting aggressively, which is expensive but not broken.
2. A `401` means the sign-in needs renewing — run `cursor_login` again.
3. A `CURSOR_PROTOCOL` or `CURSOR_ERROR` failure, or a rejected run, usually means Cursor changed the
   protocol or the client version. There is no user-side fix; the plugin needs an update.
4. Never retry a failed run automatically. Cursor's streaming POST cannot prove the request was not
   processed remotely, so a retry can duplicate model work and burn the user's quota. Report the failure
   and let the user decide.

## Reporting honestly

- Cursor does not expose cache-hit telemetry to third-party clients. Do not claim a cache-hit rate.
  The measurable number is the **resume rate** from `cursor_status`.
- Token counts come from Cursor's own accounting. If Cursor reports nothing, the shim reports zero rather
  than an estimate.
- This is an unofficial integration of a private API. Say so if the user asks, and point them at the
  account-risk notice shown at sign-in.

## Safety

The plugin stores a Cursor OAuth token at `0600` inside the plugin's private data directory. Never print,
log, echo or summarise that token, and never read the credential file directly — use `cursor_status`,
which returns only whether a credential exists, when it expires, and which account it belongs to.
