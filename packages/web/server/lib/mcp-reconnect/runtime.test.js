import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMcpReconnectRuntime } from './runtime.js';

const temporaryDirectories = [];
const disposers = [];

afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const materialize = async (rawConfig = '{}') => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-mcp-reconnect-'));
  temporaryDirectories.push(dataDir);
  const runtime = createMcpReconnectRuntime({ fsPromises: fs, path, dataDir });
  const prepared = await runtime.prepareManagedOpenCodeEnv(rawConfig);
  const pluginPath = path.join(dataDir, 'mcp-reconnect', 'openchamber-mcp-reconnect-plugin.js');
  const pluginModule = await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}-${Math.random()}`);
  return { prepared, pluginPath, plugin: pluginModule.OpenChamberMcpReconnectPlugin };
};

/**
 * A stand-in for the SDK client OpenCode hands to plugins. `statuses` is live
 * state the test mutates; `connect` records when each attempt happened.
 */
const createClient = (statuses, { onConnect, configs = Object.fromEntries(Object.keys(statuses).map((name) => [name, { type: 'remote', url: 'https://mcp.example.test' }])) } = {}) => {
  const attempts = [];
  return {
    attempts,
    statuses,
    config: {
      get: vi.fn(async () => ({ data: { mcp: configs } })),
    },
    mcp: {
      status: vi.fn(async () => ({ data: { ...statuses } })),
      connect: vi.fn(async ({ path: { name } }) => {
        attempts.push({ name, at: Date.now() });
        onConnect?.(name);
        return { data: true };
      }),
    },
  };
};

const start = async (plugin, client) => {
  const hooks = await plugin({ client });
  disposers.push(hooks.dispose);
  return hooks;
};

describe('managed MCP reconnect runtime', () => {
  it('materializes the plugin and preserves existing plugin entries', async () => {
    const { prepared, pluginPath } = await materialize('{ "plugin": ["file:///existing.js"], "model": "test/model" }');
    const config = JSON.parse(prepared.OPENCODE_CONFIG_CONTENT);
    expect(config.model).toBe('test/model');
    expect(config.plugin).toEqual(['file:///existing.js', pathToFileURL(pluginPath).href]);
  });

  it('reconnects only servers in the failed state', async () => {
    vi.useFakeTimers();
    const { plugin } = await materialize();
    const client = createClient({
      broken: { status: 'failed', error: 'spawn ENOENT' },
      healthy: { status: 'connected' },
      off: { status: 'disabled' },
      login: { status: 'needs_auth' },
      registration: { status: 'needs_client_registration', error: 'no client id' },
    });
    await start(plugin, client);

    await vi.advanceTimersByTimeAsync(1000);

    expect(client.attempts.map((attempt) => attempt.name)).toEqual(['broken']);
  });

  it('stops after three attempts while a remote server keeps failing', async () => {
    vi.useFakeTimers();
    const { plugin } = await materialize();
    const client = createClient({ broken: { status: 'failed', error: 'refused' } });
    const started = Date.now();
    await start(plugin, client);

    await vi.advanceTimersByTimeAsync(600_000);

    expect(client.attempts.map((attempt) => attempt.at - started)).toEqual([
      1000, 2000, 4000,
    ]);
  });

  it('never reconnects local or unclassified servers across fifteen directories', async () => {
    vi.useFakeTimers();
    const { plugin } = await materialize();
    const clients = Array.from({ length: 15 }, () => createClient({
      python: { status: 'failed' },
      missing: { status: 'failed' },
      disabled: { status: 'failed' },
    }, { configs: {
      python: { type: 'local', command: ['uvx', 'example-mcp'] },
      disabled: { type: 'remote', url: 'https://mcp.example.test', enabled: false },
    } }));
    await Promise.all(clients.map((client) => start(plugin, client)));

    await vi.advanceTimersByTimeAsync(600_000);

    expect(clients.reduce((count, client) => count + client.attempts.length, 0)).toBe(0);
    expect(clients.every((client) => client.mcp.status.mock.calls.length > 0)).toBe(true);
  });

  it('stops retrying once a server is back and starts fresh when it drops again', async () => {
    vi.useFakeTimers();
    const { plugin } = await materialize();
    const statuses = { flaky: { status: 'failed', error: 'refused' } };
    const client = createClient(statuses, {
      onConnect: () => { statuses.flaky = { status: 'connected' }; },
    });
    const hooks = await start(plugin, client);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.attempts).toHaveLength(1);

    statuses.flaky = { status: 'failed', error: 'Connection closed' };
    await hooks.event({ event: { type: 'mcp.tools.changed', properties: { server: 'flaky' } } });
    await vi.advanceTimersByTimeAsync(1000);

    expect(client.attempts).toHaveLength(2);
    expect(client.attempts[1].at - client.attempts[0].at).toBeGreaterThan(30_000);
  });

  it('keeps going when status is temporarily unavailable', async () => {
    vi.useFakeTimers();
    const { plugin } = await materialize();
    const client = createClient({ broken: { status: 'failed', error: 'refused' } });
    client.mcp.status.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await start(plugin, client);

    await vi.advanceTimersByTimeAsync(1000);
    expect(client.attempts).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.attempts).toHaveLength(1);
  });

  it('preserves the exhausted budget across SDK errors and repeated events', async () => {
    vi.useFakeTimers();
    const { plugin } = await materialize();
    const client = createClient({ broken: { status: 'failed' } });
    const hooks = await start(plugin, client);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.attempts).toHaveLength(3);

    client.mcp.status.mockResolvedValueOnce({ error: { message: 'unavailable' } });
    for (let index = 0; index < 10; index += 1) {
      await hooks.event({ event: { type: 'mcp.tools.changed' } });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(client.attempts).toHaveLength(3);

    client.statuses.broken = { status: 'disabled' };
    await vi.advanceTimersByTimeAsync(30_000);
    client.statuses.broken = { status: 'failed' };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.attempts).toHaveLength(3);

    client.statuses.broken = { status: 'connected' };
    await vi.advanceTimersByTimeAsync(30_000);
    client.statuses.broken = { status: 'failed' };
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.attempts).toHaveLength(6);
  });

  it('skips reconnect when effective configuration is unavailable', async () => {
    vi.useFakeTimers();
    const { plugin } = await materialize();
    const client = createClient({ broken: { status: 'failed' } });
    client.config.get.mockResolvedValueOnce({ error: { message: 'unavailable' } });
    client.config.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await start(plugin, client);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(client.attempts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.attempts).toHaveLength(1);
  });

  it('rechecks configuration before retrying a server changed to local', async () => {
    vi.useFakeTimers();
    const { plugin } = await materialize();
    const configs = { broken: { type: 'remote', url: 'https://mcp.example.test' } };
    const client = createClient({ broken: { status: 'failed' } }, { configs });
    await start(plugin, client);
    await vi.advanceTimersByTimeAsync(1000);
    configs.broken = { type: 'local', command: ['python', 'server.py'] };
    await vi.advanceTimersByTimeAsync(600_000);
    expect(client.attempts).toHaveLength(1);
  });

  it('bounds rejected connect calls without blocking another server', async () => {
    vi.useFakeTimers();
    const { plugin } = await materialize();
    const client = createClient({ broken: { status: 'failed' }, healthy: { status: 'failed' } });
    client.mcp.connect.mockImplementation(async ({ path: { name } }) => {
      if (name === 'broken') throw new Error('ECONNREFUSED');
      client.statuses.healthy = { status: 'connected' };
      return { data: true };
    });
    await start(plugin, client);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(client.mcp.connect.mock.calls.filter(([request]) => request.path.name === 'broken')).toHaveLength(3);
    expect(client.mcp.connect.mock.calls.filter(([request]) => request.path.name === 'healthy')).toHaveLength(1);
  });

  it.each(['status', 'config'])('does not connect after disposal during a pending %s read', async (pending) => {
    vi.useFakeTimers();
    const { plugin } = await materialize();
    const client = createClient({ broken: { status: 'failed' } });
    let resolveRead;
    const read = new Promise((resolve) => { resolveRead = resolve; });
    if (pending === 'status') client.mcp.status.mockReturnValueOnce(read);
    else client.config.get.mockReturnValueOnce(read);
    const hooks = await start(plugin, client);
    await vi.advanceTimersByTimeAsync(1000);
    await hooks.dispose();
    resolveRead(pending === 'status'
      ? { data: { broken: { status: 'failed' } } }
      : { data: { mcp: { broken: { type: 'remote' } } } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.attempts).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps one reconnect in flight despite repeated events and disposes without rescheduling', async () => {
    vi.useFakeTimers();
    const { plugin } = await materialize();
    const client = createClient({ broken: { status: 'failed' } });
    let resolveConnect;
    client.mcp.connect.mockReturnValueOnce(new Promise((resolve) => { resolveConnect = resolve; }));
    const hooks = await start(plugin, client);
    await vi.advanceTimersByTimeAsync(1000);
    for (let index = 0; index < 10; index += 1) {
      await hooks.event({ event: { type: 'mcp.tools.changed' } });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(client.mcp.connect).toHaveBeenCalledTimes(1);
    expect(client.mcp.status).toHaveBeenCalledTimes(1);
    await hooks.dispose();
    resolveConnect({ data: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.mcp.connect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does nothing after dispose', async () => {
    vi.useFakeTimers();
    const { plugin } = await materialize();
    const client = createClient({ broken: { status: 'failed', error: 'refused' } });
    const hooks = await plugin({ client });

    await hooks.dispose();
    await hooks.event({ event: { type: 'mcp.tools.changed', properties: { server: 'broken' } } });
    await vi.advanceTimersByTimeAsync(120_000);

    expect(client.mcp.status).not.toHaveBeenCalled();
    expect(client.attempts).toHaveLength(0);
  });
});
