# Notices

## Ported code

This plugin is a port of, and includes code derived from:

**dsh-cursor-subscription** — <https://github.com/orrinzeng/dsh-cursor-subscription>
Copyright (c) orrinzeng. Licensed under the MIT License.

The following are derived from that project, with modifications for the ZCode host:

| File | Derivation |
|---|---|
| `lib/proto.mjs` | `lib/proto.js` plus the Connect framing from `lib/index.js` |
| `lib/auth.mjs` | the PKCE login, polling, refresh and token helpers from `lib/index.js` |
| `lib/cursor-client.mjs` | the protobuf encoders/decoders, `AgentRun` transport, and model discovery from `lib/index.js` |

The original project's field numbers, header set, timing constants and exec-rejection table were
re-derived for a host that owns its own tools and permissions. See [`docs/RESEARCH-FINDINGS.md`](../docs/RESEARCH-FINDINGS.md)
for the full analysis and citations, and [`docs/REVIEW-REPORT.md`](../docs/REVIEW-REPORT.md) for the
adversarial review that shaped the protocol code.

The MIT licence of the original project is reproduced in `LICENSE`.

## Not affiliated with Anysphere

This plugin is an unofficial, community-built integration. It is not affiliated with, endorsed by, or
supported by Anysphere or Cursor.

## Reverse-engineered API

Cursor's agent protocol (`api2.cursor.sh`, Connect-RPC + protobuf) is **undocumented**. This plugin
reimplements a subset of it by observation. It may stop working when Cursor changes its servers or
client version, and using a consumer subscription through a third-party client may conflict with
Cursor's terms of service. Users are shown this notice before signing in.
