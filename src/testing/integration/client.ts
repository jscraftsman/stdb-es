import { spawn, type ChildProcess } from 'node:child_process';
import type {
  IntegrationClient,
  IntegrationConnectOptions,
  IntegrationJson,
  IntegrationRow,
  IntegrationWaitOptions,
} from './types.js';
import { waitFor } from './util.js';

type ChangeSet = {
  inserts?: readonly IntegrationJson[];
  deletes?: readonly IntegrationJson[];
  updates?: readonly unknown[];
};

type SubscriptionUpdate = Record<string, ChangeSet>;

type ClientOptions = IntegrationConnectOptions & {
  serverArg: string;
  database: string;
  cwd: string;
  timeoutMs: number;
};

function asRow(value: unknown): IntegrationRow | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as IntegrationRow)
    : null;
}

function rowKey(row: IntegrationRow): string {
  return JSON.stringify(row);
}

/**
 * Live subscription client backed by `spacetime subscribe`.
 *
 * The CLI owns the WebSocket, so this entry stays compatible with any Node
 * version supported by the SpacetimeDB CLI and needs no generated bindings.
 */
export class CliIntegrationClient implements IntegrationClient {
  private readonly caches = new Map<string, Map<string, IntegrationRow>>();
  private readonly children: ChildProcess[] = [];
  private readonly stderr: string[] = [];
  private closed = false;
  private failure: Error | undefined;

  constructor(private readonly options: ClientOptions) {}

  async subscribe(query: string): Promise<void> {
    if (this.closed) throw new Error('Integration client is closed');
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new Error('Subscription query must be a non-empty string');
    }

    const args = [
      'subscribe',
      '-s',
      this.options.serverArg,
      ...(this.options.anonymous ? ['--anonymous'] : []),
      ...(this.options.printInitialUpdate === false ? [] : ['--print-initial-update']),
      this.options.database,
      query,
    ];
    const child = spawn('spacetime', args, {
      cwd: this.options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.children.push(child);

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) this.applyLine(line);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr.push(chunk);
    });

    child.on('error', (error) => {
      this.failure = new Error(`spacetime subscribe could not start: ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      if (this.closed || code === 0) return;
      const detail = this.stderr.join('').trim();
      this.failure = new Error(
        `spacetime subscribe exited with ${signal ?? code}${detail ? `: ${detail}` : ''}`,
      );
    });
  }

  rows(table: string): readonly IntegrationRow[] {
    return [...(this.caches.get(table)?.values() ?? [])];
  }

  tables(): readonly string[] {
    return [...this.caches.keys()];
  }

  async waitFor(
    predicate: (client: IntegrationClient) => boolean | Promise<boolean>,
    options: IntegrationWaitOptions = {},
  ): Promise<void> {
    try {
      await waitFor(
        () => {
          if (this.failure) throw this.failure;
          return predicate(this);
        },
        { timeoutMs: this.options.timeoutMs, ...options },
      );
    } catch (error) {
      const detail = this.stderr.join('').trim();
      if (detail && error instanceof Error && !error.message.includes(detail)) {
        throw new Error(`${error.message}\n${detail}`);
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      this.children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            child.once('exit', () => resolve());
            child.kill();
          }),
      ),
    );
  }

  private applyLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let update: unknown;
    try {
      update = JSON.parse(trimmed);
    } catch (error) {
      this.failure = new Error(
        `Could not parse subscription update: ${(error as Error).message}\n${trimmed}`,
      );
      return;
    }
    if (typeof update !== 'object' || update === null || Array.isArray(update)) return;

    for (const [table, rawChanges] of Object.entries(update as SubscriptionUpdate)) {
      const cache = this.caches.get(table) ?? new Map<string, IntegrationRow>();
      this.caches.set(table, cache);

      for (const row of rawChanges?.deletes ?? []) {
        const parsed = asRow(row);
        if (parsed) cache.delete(rowKey(parsed));
      }
      for (const row of rawChanges?.inserts ?? []) {
        const parsed = asRow(row);
        if (parsed) cache.set(rowKey(parsed), parsed);
      }
      for (const change of rawChanges?.updates ?? []) this.applyUpdatePair(cache, change);
    }
  }

  private applyUpdatePair(cache: Map<string, IntegrationRow>, change: unknown): void {
    if (Array.isArray(change) && change.length >= 2) {
      const oldRow = asRow(change[0]);
      const newRow = asRow(change[1]);
      if (oldRow) cache.delete(rowKey(oldRow));
      if (newRow) cache.set(rowKey(newRow), newRow);
      return;
    }

    const pair = asRow(change);
    if (!pair) return;
    const oldRow = asRow(pair['old']);
    const newRow = asRow(pair['new']);
    if (oldRow) cache.delete(rowKey(oldRow));
    if (newRow) cache.set(rowKey(newRow), newRow);
  }
}
