import { pathToFileURL } from 'node:url';
import { appendManagedPlugin } from '../opencode/managed-plugin-config.js';

/**
 * OpenCode marks an MCP server `failed` when it does not come up at startup or
 * when a live connection drops, and never tries again. This plugin runs inside
 * the managed OpenCode process and retries remote servers at most three times
 * per failure episode. Local servers require manual recovery: reconnect can
 * spawn another process, and this plugin cannot verify prior process cleanup.
 *
 * Only `failed` is retried. `needs_auth`, `needs_client_registration`, and
 * `disabled` are user decisions or need user action, and retrying them would
 * either loop on a login prompt or re-enable a server the user turned off.
 *
 * The plugin talks to OpenCode through the SDK client OpenCode hands it, which
 * is scoped to one project directory, so each open directory reconnects its
 * own servers. Nothing is logged: OpenCode already reports each failed attempt.
 */
const createPluginSource = () => String.raw`
const INITIAL_RETRY_MS = 1000
const MAX_ATTEMPTS = 3
const IDLE_CHECK_MS = 30000

export const OpenChamberMcpReconnectPlugin = async ({ client }) => {
  let disposed = false
  let running = false
  let wakeRequested = false
  let timer
  // Consecutive failed attempts per server, cleared once it is seen healthy.
  const attempts = new Map()
  const dueAt = new Map()

  const schedule = (delayMs) => {
    if (disposed) return
    clearTimeout(timer)
    timer = setTimeout(tick, delayMs)
  }

  const tick = async () => {
    if (disposed) return
    if (running) {
      wakeRequested = true
      return
    }
    running = true
    let delay = IDLE_CHECK_MS
    try {
      const result = await client.mcp.status()
      if (disposed || result?.error || !result?.data) return
      const statuses = result.data
      const now = Date.now()
      const due = []
      for (const [name, entry] of Object.entries(statuses)) {
        if (entry?.status === "connected") {
          attempts.delete(name)
          dueAt.delete(name)
        }
        if (entry?.status !== "failed" || (attempts.get(name) ?? 0) >= MAX_ATTEMPTS) continue
        const at = dueAt.get(name) ?? now
        if (at > now) {
          delay = Math.min(delay, at - now)
          continue
        }
        due.push(name)
      }
      for (const name of attempts.keys()) {
        if (!Object.hasOwn(statuses, name)) {
          attempts.delete(name)
          dueAt.delete(name)
        }
      }

      if (due.length === 0) return
      // Read the effective directory config, including project overrides.
      // Missing config or an SDK error must never authorize a local restart.
      const config = await client.config.get()
      if (disposed || config?.error || !config?.data) return
      const remote = due.filter((name) => {
        const server = config.data.mcp?.[name]
        return server?.type === "remote" && server.enabled !== false
      })
      await Promise.allSettled(remote.map((name) => client.mcp.connect({ path: { name } })))

      // The result is read on the next tick: a server that came back clears
      // its counter there, one still failed waits out its backoff.
      const after = Date.now()
      for (const name of remote) {
        const count = (attempts.get(name) ?? 0) + 1
        const wait = INITIAL_RETRY_MS * 2 ** (count - 1)
        attempts.set(name, count)
        dueAt.set(name, after + wait)
        if (count < MAX_ATTEMPTS) delay = Math.min(delay, wait)
      }
    } catch {
      // Status is unavailable while OpenCode is shutting down or restarting;
      // the idle check picks up again when it is back.
    } finally {
      running = false
      const wake = wakeRequested
      wakeRequested = false
      schedule(wake ? INITIAL_RETRY_MS : delay)
    }
  }

  schedule(INITIAL_RETRY_MS)

  return {
    // A dropped connection publishes this event; checking right away beats
    // waiting out the idle interval.
    event: async ({ event }) => {
      if (event?.type === "mcp.tools.changed") schedule(INITIAL_RETRY_MS)
    },
    dispose: async () => {
      disposed = true
      clearTimeout(timer)
    },
  }
}
`;

export const createMcpReconnectRuntime = ({ fsPromises, path, dataDir }) => {
  const pluginDirectory = path.join(dataDir, 'mcp-reconnect');
  const pluginPath = path.join(pluginDirectory, 'openchamber-mcp-reconnect-plugin.js');

  const prepareManagedOpenCodeEnv = async (rawConfig) => {
    await fsPromises.mkdir(pluginDirectory, { recursive: true });
    await fsPromises.writeFile(pluginPath, createPluginSource(), { mode: 0o600 });
    return {
      OPENCODE_CONFIG_CONTENT: appendManagedPlugin(rawConfig, pathToFileURL(pluginPath).href, 'MCP reconnect plugin'),
    };
  };

  return { prepareManagedOpenCodeEnv };
};
