---
description: Uninstall the Cursor Subscription plugin completely, so a reinstall starts fresh.
---

Remove the Cursor Subscription plugin properly — the plugin itself, not just the connection — so that
installing it again later comes up clean instead of inheriting whatever the last install left behind.

## What this removes

Uninstalling the plugin from the marketplace only removes the plugin. These survive it, and a
reinstall inherits all of them:

| Left behind | Effect on the next install |
|---|---|
| Stored Cursor credential | Still signed in — a token the user asked to discard |
| Provider entry in ZCode's config | A provider in the picker that fails on every use |
| Model rules | Removed models still listed as enabled |
| Install record, cache, data dir | ZCode still believes the plugin is installed |
| Enabled flag | It loads again at next launch |

## What to do

Call `cursor_uninstall` **without** `confirmed` first. It replies with exactly what it will remove —
show that to the user and ask them to agree.

Once they agree, call it again with `confirmed: true`, then report the result verbatim.

**Report problems honestly.** If a step reports `NOT removed` or `Could not remove`, say which one and
what it means, rather than summarising the uninstall as complete.

## After it runs

Tell the user to **quit ZCode completely (⌘Q, not just close the window) and reopen it**. This is
required and not optional: the process that ran the uninstall is still executing from files that have
been deleted, and ZCode caches the provider list it read at startup. The restart is what finishes the
job.

Also tell them:

- **The marketplace is still registered.** They can install Cursor Subscription again whenever they
  want, and it will come up signed out with no provider — a genuinely clean start.
- **`/connect-cursor` is the way back.** It walks the whole setup again: adopt the session, verify it,
  register the provider models.
- **Nothing else was touched.** Other providers, other plugins, and other marketplaces are untouched.

## If the user only wants to sign out

Call `cursor_logout` instead. It deletes the credential and keeps the plugin installed. Do not use it
when the user said "uninstall" — a signed-out plugin still shows a provider that cannot answer, which
is the exact leftover this command exists to remove.
