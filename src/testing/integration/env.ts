import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { cliArgs, parseSqlResult, runCli } from './cli.js';
import { CliIntegrationClient } from './client.js';
import type { CreateIntegrationEnvOptions, IntegrationEnv } from './types.js';
import { delay, waitFor } from './util.js';

/** Builds a CLI-safe database name with a random suffix. */
export function integrationDatabase(prefix = 'stdb-es-test'): string {
  const clean =
    prefix
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'stdb-es-test';
  return `${clean}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || /^wss?:\/\//i.test(value);
}

function httpUrl(value: string): string {
  return value.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address !== 'string') resolve(address.port);
        else reject(new Error('Could not allocate a local server port'));
      });
    });
  });
}

function stopChild(child: ChildProcess, detached = false): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());

    if (process.platform === 'win32' && child.pid !== undefined) {
      // `spacetime start` launches the standalone server as a child. Killing
      // only the CLI leaves that child listening on the port.
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      killer.once('exit', () => resolve());
    } else if (detached && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill();
      }
    } else {
      child.kill();
    }

    // A process that ignores SIGTERM must not hang `dispose()`.
    void delay(2_000).then(resolve);
  });
}

/**
 * Creates a disposable, real SpacetimeDB environment for consumer tests.
 *
 * With the default `server: 'local'` it spawns an in-memory standalone server
 * on a free port with its own temporary data directory, and owns both until
 * `dispose()`. An explicit URL or CLI nickname reuses an existing server; the
 * environment never stops a process it did not start.
 */
export async function createIntegrationEnv(
  options: CreateIntegrationEnvOptions = {},
): Promise<IntegrationEnv> {
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const requestedServer = options.server ?? 'local';
  const database = options.database ?? integrationDatabase();
  const clients = new Set<CliIntegrationClient>();

  let serverArg = requestedServer;
  let ownedServer: ChildProcess | undefined;
  let ownedDataDir: string | undefined;
  let serverLog = '';
  let serverFailure: Error | undefined;
  let disposed = false;

  const cleanup = async (): Promise<void> => {
    await Promise.all(
      [...clients].map((client) => client.close().catch(() => undefined)),
    );
    clients.clear();

    if (!options.keepDatabase) {
      // A disposable server disappears on stop, so a failed delete is not a
      // reason to abort teardown.
      await runCli(['delete', '-s', serverArg, database, '-y'], cwd).catch(() => undefined);
    }
    if (ownedServer && !options.keepServer) await stopChild(ownedServer);
    // The standalone server takes a pid lock inside its data directory. Each
    // owned server gets its own directory so parallel servers (including an
    // existing CI server on :3000) never contend for the same lock file.
    if (ownedDataDir && !options.keepServer) {
      fs.rmSync(ownedDataDir, { recursive: true, force: true });
    }
  };

  try {
    if (requestedServer === 'local') {
      const port = options.port ?? (await freePort());
      serverArg = `http://127.0.0.1:${port}`;
      ownedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stdb-es-integration-'));

      const child = spawn(
        'spacetime',
        [
          'start',
          '--in-memory',
          '--non-interactive',
          '--data-dir',
          ownedDataDir,
          '-l',
          `127.0.0.1:${port}`,
        ],
        { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' },
      );
      ownedServer = child;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        serverLog += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        serverLog += chunk;
      });
      child.on('error', (error) => {
        serverFailure = new Error(`Could not start the local SpacetimeDB server: ${error.message}`);
      });
      child.on('exit', (code, signal) => {
        if (code !== 0 && signal !== 'SIGTERM') {
          serverFailure = new Error(
            `Local SpacetimeDB server exited with ${signal ?? code}:\n${serverLog}`,
          );
        }
      });

      await waitFor(
        async () => {
          if (serverFailure) throw serverFailure;
          try {
            const response = await fetch(`${serverArg}/v1/health`);
            return response.ok;
          } catch {
            return false;
          }
        },
        { timeoutMs, intervalMs: 100, description: `local server ${serverArg}` },
      );
    } else if (isUrl(requestedServer)) {
      serverArg = httpUrl(requestedServer);
    }

    if (options.publish !== false) {
      await runCli(
        [
          'publish',
          database,
          '-s',
          serverArg,
          '-p',
          options.modulePath ?? 'spacetimedb',
          ...(options.deleteData === false ? [] : ['--delete-data=always']),
          '-y',
        ],
        cwd,
      );
    }

    const env: IntegrationEnv = {
      server: serverArg,
      database,
      modulePath: options.modulePath ?? 'spacetimedb',

      async call(name, args, callOptions = {}) {
        await runCli(
          [
            'call',
            '-s',
            serverArg,
            ...(callOptions.anonymous ? ['--anonymous'] : []),
            database,
            name,
            '--',
            ...cliArgs(args),
          ],
          cwd,
        );
      },

      async sql(query, sqlOptions = {}) {
        const output = await runCli(
          [
            'sql',
            '-s',
            serverArg,
            ...(sqlOptions.anonymous ? ['--anonymous'] : []),
            database,
            query,
            '--format',
            'json',
          ],
          cwd,
        );
        return parseSqlResult(output);
      },

      async connect(connectOptions = {}) {
        const client = new CliIntegrationClient({
          ...connectOptions,
          serverArg,
          database,
          cwd,
          timeoutMs: connectOptions.timeoutMs ?? timeoutMs,
        });
        clients.add(client);
        for (const query of connectOptions.queries ?? []) await client.subscribe(query);
        return client;
      },

      async waitFor(predicate, waitOptions = {}) {
        await waitFor(predicate, { timeoutMs, ...waitOptions });
      },

      async dispose() {
        if (disposed) return;
        disposed = true;
        await cleanup();
      },
    };

    return env;
  } catch (error) {
    // A caller cannot dispose an environment that was never returned.
    await cleanup();
    throw error;
  }
}
