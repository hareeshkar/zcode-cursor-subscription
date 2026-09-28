---
description: Connect and initialise Cursor as a ZCode model provider, end to end.
---

## Call `cursor_connect_and_initialize` — that is the whole command

One tool call performs the entire setup: it adopts the Cursor session already on this machine, proves
with a real completion that it can answer, creates the provider entry in ZCode's config, and publishes
the model list. **There is nothing for the user to do in Settings, and nothing to copy and paste.**

Do not run `cursor_import`, `cursor_selftest` and `cursor_register_models` as separate steps. That
multi-step version is why onboarding went wrong before: each step is a separate instruction to follow,
so any one of them can be skipped, half-done, or improvised at. One call cannot be.

Do not edit `provider_config.json`, `installed_plugins.json`, or anything under `~/.zcode/cli/plugins/`
with your own file tools. A hand edit has no atomic write, no schema awareness, can destroy the user's
other providers, and will not match what the plugin's own registration expects.

Pass `models` only if the user asks for a specific number; the default publishes 12.

## If the tool is not available

If you cannot call `cursor_connect_and_initialize`, stop and say exactly this: the plugin's tools are not loaded in
this session — quit ZCode completely (⌘Q, not just close the window) and reopen it, then run
`/connect-cursor-and-initialize` again. MCP connections are built when a session starts, so a plugin installed or
reinstalled mid-session has no tools until the next launch. Then stop. Do not fall back to editing
files, and do not attempt any step by hand.

## Reporting the result

Relay the tool's output faithfully.

- **On success** it says `Connected.` and names the model to pick. Tell the user the only remaining step
  is to quit ZCode (⌘Q) and reopen it, because the model picker reads the config at startup — that is a
  restart, not a configuration task. Do not repeat the base URL, API key or paths back to them; the
  provider is already written.
- **If it stops**, it says why at a specific step and changes nothing in ZCode's config. Report that
  step and its advice verbatim. Do not tell the user to go and configure anything by hand unless the
  output itself prints the values for that purpose — it only does so when it could not finish.

## When something is broken later

Run `cursor_doctor`. It is read-only and reports what *disagrees*: the session, the shim, and whether
ZCode's provider entry points at the port the shim is actually serving. It probes the socket rather
than trusting what this process decided at startup, so it reports a dead port as dead. Fix what it
names, using the plugin's tools, and never by editing the config yourself.
