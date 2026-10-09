---
description: Refresh the Cursor model list in ZCode's picker with everything the account can use today.
---

## Call `cursor_register_models` — that is the whole command

One tool call fetches the live model list from Cursor and writes it into ZCode's provider config. New
models your subscription gained (and any it lost) are reflected in one step — no Settings visits, no
scripts, no hand edits.

Report to the user:

- how many models are registered now, and how many were newly added,
- the provider name it wrote to (and whether the base URL was re-aligned to the shim's port),
- that **ZCode must be restarted (⌘Q, not just closing the window)** before the updated list appears —
  the model picker reads the provider config at startup.

Pass `models: N` only if the user asks to cap the list to a short one; the default publishes every
model the account can use, which is what most people want — the picker searches.

## Do not do any of this by hand

- Do not edit `provider_config.json` or anything under `~/.zcode/cli/plugins/` with your own file
  tools. Hand edits have no atomic write and no schema awareness, and can destroy the user's other
  providers.
- Do not write scripts that import the plugin's internal modules to "work around" a tool. If a tool's
  output looks wrong — unreadable, truncated, `[object Object]` — that is a bug in the plugin worth
  reporting, not a reason to bypass it. The supported tools produce the complete answer.

## If the tool is not available

If you cannot call `cursor_register_models`, stop and say exactly this: the plugin's tools are not
loaded in this session — quit ZCode completely (⌘Q) and reopen it, then run `/cursor-update-models`
again. MCP connections are built when a session starts, so a plugin installed or updated mid-session
has no tools until the next launch. Then stop — do not improvise an alternative path.
