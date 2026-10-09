# Agent installation guide

Use this guide when a user asks an Agent to install, update, verify, connect, or remove
`cursor-subscription` for ZCode.

## Safety

Read this before touching anything.

- **Never print, echo, log, or summarise a credential.** No OAuth access token, no refresh token, no
  the contents of `credentials.json`, no `shim-key`. Report only *whether* a credential exists, when it
  expires, and which account it belongs to — that is what `cursor_status` returns.
- **Do not restart ZCode without explicit permission.** ZCode reads the provider config at startup, so a
  restart is required for new models to appear, but quitting someone's editor mid-task is disruptive.
  Recommend it; let them do it.
- **Do not delete the clone.** The directory *is* the marketplace ZCode reads from.
- **Do not edit ZCode's config files by hand.** `provider_config.json`, `installed_plugins.json` and
  anything under `~/.zcode/cli/plugins/` are the plugin's to manage. The plugin's tools write them
  atomically and preserve every other key; a hand edit does not.
- **Preserve everything else.** Other providers, other plugins and other marketplaces are never touched.
  Signing out or uninstalling requires explicit permission.
- **Show the account-risk notice before sign-in.** This relays a consumer subscription through a
  third-party client, which is the activity most likely to trip Cursor's account protections. The
  plugin shows it itself; do not skip past it.
- **Never retry a failed Cursor run automatically.** Cursor's streaming protocol cannot prove a failed
  attempt was not processed remotely, so an automatic retry can duplicate work and spend the user's
  quota. Report it and let them decide.

## What this is

A self-hosted ZCode plugin marketplace. The repository root contains `marketplace.json`; the plugin
itself is in `cursor-subscription/`. It is **not** on the official ZCode marketplace.

## Install

### 1. Clone

```sh
git clone https://github.com/hareeshkar/zcode-cursor-subscription.git
```

Clone to a stable location. The folder must stay where it is put — it is the marketplace source.

### 2. Get the absolute path

ZCode needs an **absolute path to the folder containing `marketplace.json`**, not the file inside it and
not the `cursor-subscription` subfolder.

**macOS / Linux** — in the cloned folder:

```sh
pwd          # → /Users/you/zcode-cursor-subscription
```

Or drag the folder from Finder into a Terminal window to have the path filled in. The tilde (`~`) is
not accepted; expand it.

**Windows (PowerShell)** — in the cloned folder:

```powershell
(Get-Location).Path        # → C:\Users\you\zcode-cursor-subscription
```

**Windows (Command Prompt)**:

```
cd
```

Confirm before continuing: the path must end in the folder you cloned, and that folder must contain
`marketplace.json`.

```sh
ls marketplace.json
```

### 3. Register the folder as a marketplace

**ZCode → Plugin Marketplace → Add → Add Plugin Marketplace**, then paste the absolute path.

Equivalent CLI, once the marketplace is registered:

```sh
zcode plugins install cursor-subscription@dev-zcode-cursor-b9b95b48
```

If the marketplace list is empty after adding, the path is wrong. ZCode resolves it literally and fails
quietly — check for a missing folder name, a `~`, or quotes pasted along with the path.

### 4. Install the plugin

Open that marketplace and install **Cursor Subscription**.

**Nothing happens on install.** No network call, no browser, no credential is read. The install copies
files to `~/.zcode/cli/plugins/cache/`.

### 5. Connect

```
/connect-cursor-and-initialize
```

One call that adopts the Cursor session, proves it can answer, creates the provider entry, and publishes
every model the account can use. It stops and explains itself at any step it cannot complete, without
writing a half-configured provider.

**The user's Cursor session is adopted, not re-created.** It is read from Cursor's own local store and
verified against Cursor before being kept. The user is never asked to sign in twice. Only a machine with
no signed-in Cursor install falls back to a browser flow, and the plugin decides that, not you.

### 6. Restart, then pick a model

Ask the user to quit ZCode completely (**⌘Q**, not just closing the window) and reopen. The model picker
reads the config at startup, so models will not appear until they do. Then they choose a model from the
**Cursor Subscription** provider.

## Verify

Report what these say; do not infer success from a working chat turn.

| Command | Answers |
|---|---|
| `/cursor-status` | Is a Cursor session stored, when does it expire, which port is the shim serving, and the resume rate |
| `cursor_doctor` | Do the session, the shim and the provider entry all agree — and if not, which one is wrong |

From a terminal:

```sh
zcode commands list          # the four commands are registered
zcode plugins list           # the plugin is enabled, with its skills/commands/mcp counts
```

A green check is: `cursor_doctor` reports no problems, and the provider's Base URL matches the port the
shim is serving.

## Update

```sh
cd <clone>
git pull
```

Then reinstall from the marketplace — remove, then install again — and restart ZCode. There is no hot
reload; ZCode copies from the marketplace into its cache at install time, and reads the cache.

**Updating the plugin and updating the model list are different operations.** A plugin update replaces
code; it does not refresh the models the account can use. To refresh the model list (new models the
subscription gained), run the `/cursor-update-models` command — it calls `cursor_register_models`,
writes the account's current live list into ZCode's provider config, and needs a ZCode restart to
appear. `/cursor-models` lists the same inventory read-only.

## Remove

```
/uninstall-cursor-and-plugin
```

Removes the credential, the provider entry, the model rules, the install record, the cache and the data
directory, then verifies nothing survived. A reinstall afterwards comes up clean and enabled.

**The marketplace registration is deliberately kept** — it is how a reinstall finds the plugin. Deleting
the clone does not uninstall the plugin; uninstall first, then delete the folder.

## The uninstall / reinstall contract

Get this wrong and the user meets a bare `invalid api key` in the UI, which
looks like a broken provider and is really stale state.

**After `/uninstall-cursor-and-plugin` there is nothing left.** No credential, no provider, no
model list, no install record, no cache, no data directory. That is the point of uninstalling.

**Reinstalling restores code only — not configuration.** So a reinstall is *not* a working setup. The
user must run `/connect-cursor-and-initialize` again. Do not tell them it is done until they have.

Two things make this easy to get wrong:

1. **ZCode holds `provider_config.json` in memory and writes its own copy back.** A provider the
   uninstall removed can reappear. Always re-check with `cursor_doctor` after any uninstall, and
   prefer a **full quit (⌘Q) and reopen** over closing the window, so ZCode reloads the file rather
   than overwriting it.
2. **A reinstall rotates the shim's API key.** The data directory is wiped, so the next launch mints
   a new key — while a resurrected provider entry still holds the old one, and every turn is 401.

Since 0.4.0 the shim **repairs (2) itself on startup**: if it finds a provider pointing at it whose
key is stale, it rewrites the key and says so on stderr. It never creates a provider, never touches
the model list, and never writes when there is nothing wrong. `cursor_doctor` also reports a mismatch
directly, comparing hashes so neither key is ever echoed.

**If a turn fails with `invalid_api_key`:**

1. Run `cursor_doctor`. A "the provider's API key is stale" line is the answer; re-running
   `/connect-cursor-and-initialize` repairs it.
2. If the doctor is clean, the shim is not serving on the port ZCode is calling — check the base URL
   matches the reported port.
3. Do not paste a key from anywhere. The shim owns it, and the provider is written from the shim's
   copy.

## Failure handling

Each failure means something different. Report the specific one and its remedy; do not retry blindly.

| Symptom | Cause | What to do |
|---|---|---|
| Marketplace list is empty | Wrong path pasted | Re-check against step 2. It must be the folder holding `marketplace.json` |
| Plugin installs but its commands are missing | Installed in a running session | MCP tools and commands load at startup. Ask the user to restart |
| `cursor_import` reports no session | Cursor installed but not signed in | Ask them to open Cursor and sign in, then retry |
| `cursor_import` reports no install | No Cursor on this machine | Ask them to install Cursor from cursor.com, sign in, then retry |
| Self-test returns 0 models | The session cannot answer | **Do not send them to Settings.** Report it; a credential refresh will not fix a transport error |
| Connection refused, nothing on the port | The shim is not running | `cursor_doctor` reports the real state. A restart clears a wedged session |
| `cursor_doctor` says the ports disagree | The shim moved ports and the provider was not updated | Re-run `/connect-cursor-and-initialize` |
| Provider 401 / `invalid_api_key` | The provider's key is stale after a reinstall | `cursor_doctor` names it; re-run `/connect-cursor-and-initialize`. The shim also self-repairs on next start |
| Models absent from the picker after connecting | ZCode has not restarted | Ask for the **full** quit and reopen |

**Do not create a provider by hand** to work around a failure. The whole point of
`cursor_connect_and_initialize` is that the plugin writes that entry itself, atomically, matching by
base URL and following the shim if it moves.
