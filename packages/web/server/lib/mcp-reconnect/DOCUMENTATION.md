# Managed MCP Reconnect

## Purpose

This module injects a plugin into managed OpenCode that gives failed remote
MCP connections three automatic recovery attempts. Local MCP recovery stays
manual: reconnecting can spawn a process, and the plugin cannot verify that
OpenCode cleaned up the previous process or its descendants.

## Runtime flow

1. `prepareManagedOpenCodeEnv(configContent)` materializes the plugin under
   `<openchamber-data-dir>/mcp-reconnect/` and appends its `file://` URL to
   `OPENCODE_CONFIG_CONTENT` through the shared merge in
   `packages/web/server/lib/opencode/managed-plugin-config.js`.
2. It is always on for managed OpenCode.
3. OpenCode loads the plugin once per project directory with an SDK client
   scoped to that directory, so each directory reconnects its own servers.
4. The plugin reads MCP status one second after load. Before reconnecting, it
   reads the effective directory config through the supplied SDK client. Only
   `type: remote` servers with `enabled !== false` and status `failed` qualify.
   Local, missing, and unclassified entries receive no automatic connect calls.
5. Each server gets at most three attempts, with one- and two-second waits
   after the first two attempts complete. An observed `connected` status resets
   its budget. A server absent from a successful status snapshot loses its
   tracking entry. Disabled and authentication states preserve the budget.
   Exhausted servers remain failed until manual recovery or directory restart;
   ordinary status checks continue every thirty seconds.
6. `mcp.tools.changed` schedules an earlier check without resetting retry
   budgets or bypassing backoff.
7. Disposal stops timers and prevents pending status/config reads from starting
   a reconnect. A connect already sent remains owned by OpenCode.

## Invariants

- Only `failed` is retried. `disabled` is the user's choice, and `needs_auth`
  or `needs_client_registration` need the user to act; retrying those would
  either re-enable a server the user turned off or loop on a login prompt.
- SDK errors and missing response data skip the pass and preserve retry
  budgets. A failed read is never an authoritative empty snapshot.
- Rejected connect requests consume attempts too. One server's rejection does
  not block another server's recovery.
- The plugin logs no config, credentials, or error payloads.
- One check runs at a time; a wake-up arriving during a check is honored once
  it finishes rather than starting a second loop.

## What the UI sees

OpenCode publishes no event when a reconnect succeeds. The chat picks the
server up on the next prompt because tools are resolved from live state, but
the MCP page reads status on bootstrap and refresh, so it can show `failed` for
a while after the server is back.

## Runtime parity

- Web and Desktop managed OpenCode: injected automatically.
- External OpenCode (`OPENCODE_HOST` or skip-start) and VS Code's separate
  OpenCode lifecycle: not injected, because OpenChamber does not control that
   process environment.

## Verification

The generated-plugin tests execute the materialized module with controlled
SDK responses and timers. They cover a ten-minute fixture across fifteen
directories with zero local/unclassified/disabled reconnects, the remote
attempt ceiling, error recovery, config changes, repeated events, and disposal
during pending reads. These operation counts do not establish the cause of a
reported Python process leak or measure real process memory.
