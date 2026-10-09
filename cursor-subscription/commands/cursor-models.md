---
description: List the Cursor models available to the signed-in account.
---

Call `cursor_models` and list the models. Each line names the model and what Cursor declares about it
(context window, capabilities); false capabilities are omitted rather than shown as absent, so an empty
bracket means only the name and display name were declared.

If discovery fails the tool returns a built-in fallback list — say so explicitly rather than presenting
the fallback as the account's real entitlements; the tool's own header marks it FALLBACK for the same
reason.

The list is read-only. To publish models to the ZCode picker, run `cursor_register_models` (it writes
ZCode's provider config and needs a ZCode restart to appear). Do not edit `provider_config.json` or
script around the MCP tools by hand: the tools are the supported path and their output is now complete —
model names, display names and capabilities are all in the response.
