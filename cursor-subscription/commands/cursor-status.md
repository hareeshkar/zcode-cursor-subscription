---
description: Show whether Cursor is signed in, the local shim's health, and its resume counters.
---

Run the `cursor_status` tool and report the result to the user verbatim.

Explain the **resume rate** if it is below 1.0: it is the share of turns that reused Cursor's
server-side conversation instead of replaying the full history. Turns replay after ZCode compacts,
edits or branches a session — that costs more tokens but is expected, not a fault.
