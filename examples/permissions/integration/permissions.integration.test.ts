import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { streamId } from 'stdb-es';
import { sqlLiteral, tableQuery, viewQuery } from 'stdb-es/client';
import {
  createIntegrationEnv,
  type IntegrationEnv,
  type IntegrationJson,
  type IntegrationRow,
} from 'stdb-es/testing/integration';
import { STREAM_PREFIXES, TABLES } from '../spacetimedb/src/domains/counter/constants.js';

const exampleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GLOBAL_STREAM = streamId(STREAM_PREFIXES.global, 'all');
const googleToken = process.env.CI ? undefined : process.env.PERMISSIONS_GOOGLE_ID_TOKEN;
const googleTest = googleToken ? it : it.skip;

let env: IntegrationEnv;

type SqlElement = { readonly name?: { readonly some?: string } };
type SqlStatement = {
  readonly schema?: { readonly elements?: readonly SqlElement[] };
  readonly rows?: readonly (readonly unknown[])[];
};

function parseHttpSql(text: string): readonly IntegrationRow[] {
  const parsed = JSON.parse(text) as SqlStatement | readonly SqlStatement[];
  const statements = Array.isArray(parsed) ? parsed : [parsed];
  const statement = statements[0];
  const columns =
    statement?.schema?.elements
      ?.map((element) => element.name?.some)
      .filter((name): name is string => typeof name === 'string') ?? [];
  return (statement?.rows ?? []).map((row) =>
    Object.fromEntries(
      columns.map((name, index) => [name, row[index] as IntegrationJson]),
    ) as IntegrationRow,
  );
}

function unwrapOption(value: IntegrationJson | undefined): IntegrationJson | undefined {
  if (Array.isArray(value)) {
    if (value[0] === 1) return undefined;
    if (value[0] === 0) return value[1];
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if ('some' in value) return (value as { readonly some: IntegrationJson }).some;
    if ('none' in value) return undefined;
  }
  return value;
}

function asNumber(value: IntegrationJson | undefined): number {
  return Number(value ?? 0);
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('PERMISSIONS_GOOGLE_ID_TOKEN has no JWT payload');
  const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
    'utf8',
  );
  return JSON.parse(json) as Record<string, unknown>;
}

async function requireOk(response: Response, label: string): Promise<void> {
  if (response.ok) return;
  const body = await response.text();
  throw new Error(`${label} failed: HTTP ${response.status} ${body}`);
}

/** HTTP calls let Node tests use a supplied bearer token, not just CLI identities. */
async function httpCall(
  target: IntegrationEnv,
  reducer: string,
  args: readonly unknown[],
  token: string,
): Promise<void> {
  const response = await fetch(
    `${target.server}/v1/database/${target.database}/call/${reducer}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    },
  );
  await requireOk(response, reducer);
}

async function httpSql(
  target: IntegrationEnv,
  query: string,
  token: string,
): Promise<readonly IntegrationRow[]> {
  const response = await fetch(`${target.server}/v1/database/${target.database}/sql`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/plain',
    },
    body: query,
  });
  await requireOk(response, 'sql');
  return parseHttpSql(await response.text());
}

async function anonymousToken(target: IntegrationEnv): Promise<string> {
  const response = await fetch(`${target.server}/v1/identity`, { method: 'POST' });
  await requireOk(response, 'identity');
  const payload = (await response.json()) as { readonly token?: unknown };
  if (typeof payload.token !== 'string') {
    throw new Error('identity response did not contain a token');
  }
  return payload.token;
}

async function publicRows(
  target: IntegrationEnv,
  where?: string,
): Promise<readonly IntegrationRow[]> {
  const query = `${tableQuery(TABLES.publicSummary)}${where ? ` ${where}` : ''}`;
  return (await target.sql(query, { anonymous: true })).rows;
}

async function globalValue(target: IntegrationEnv): Promise<number> {
  const rows = await publicRows(
    target,
    `WHERE stream_id = ${sqlLiteral(GLOBAL_STREAM)}`,
  );
  return asNumber(rows[0]?.value);
}

beforeAll(async () => {
  env = await createIntegrationEnv({
    cwd: exampleRoot,
    modulePath: 'spacetimedb',
  });
});

afterAll(async () => {
  await env?.dispose();
});

describe('permissions example against a real server', () => {
  it('lets anonymous clients write C1 and see it through public views', async () => {
    const client = await env.connect({
      anonymous: true,
      queries: [
        tableQuery(TABLES.publicSummary),
        viewQuery(TABLES.publicEvents, [GLOBAL_STREAM]),
      ],
    });

    try {
      await env.call('increment_global', [5, 'it-anon-inc'], { anonymous: true });

      await client.waitFor(
        (c) =>
          c.rows(TABLES.publicSummary).some(
            (row) => row.stream_id === GLOBAL_STREAM && asNumber(row.value) === 5,
          ),
        { description: 'anonymous C1 summary row' },
      );
      await client.waitFor((c) => c.rows(TABLES.publicEvents).length === 1, {
        description: 'public C1 event view',
      });

      await env.call('decrement_global', [2, 'it-anon-dec'], { anonymous: true });
      await env.call('reset_global', ['it-anon-reset'], { anonymous: true });
      await env.waitFor(async () => (await globalValue(env)) === 0, {
        description: 'reset C1 value',
      });
    } finally {
      await client.close();
    }
  });

  it('replays a repeated C1 command id on the live server', async () => {
    const commandId = 'it-anon-retry';
    const eventId = `inc-${GLOBAL_STREAM}-${commandId}`;
    const client = await env.connect({
      anonymous: true,
      queries: [viewQuery(TABLES.publicEvents, [GLOBAL_STREAM])],
    });

    try {
      await env.call('increment_global', [4, commandId], { anonymous: true });
      await env.call('increment_global', [4, commandId], { anonymous: true });

      await client.waitFor(
        (c) =>
          c.rows(TABLES.publicEvents).filter((row) => row.event_id === eventId).length === 1,
        { description: 'idempotent C1 event' },
      );
      expect(await globalValue(env)).toBe(4);
    } finally {
      await client.close();
    }
  });

  it('rejects anonymous writes to C2/C3 without creating owned rows', async () => {
    await expect(
      env.call('increment_public_mine', [1, 'it-anon-public'], { anonymous: true }),
    ).rejects.toThrow();
    await expect(
      env.call('increment_private_mine', [1, 'it-anon-private'], { anonymous: true }),
    ).rejects.toThrow();

    const rows = await publicRows(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stream_id: GLOBAL_STREAM,
      counter_kind: 'global',
    });
  });

  it('accepts a saved server-issued token for C1 but not for owned counters', async () => {
    const token = await anonymousToken(env);
    const before = await globalValue(env);

    await httpCall(env, 'increment_global', [2, 'it-token-inc'], token);
    await env.waitFor(async () => (await globalValue(env)) === before + 2, {
      description: 'server-issued token C1 write',
    });
    await httpCall(env, 'decrement_global', [1, 'it-token-dec'], token);
    await env.waitFor(async () => (await globalValue(env)) === before + 1, {
      description: 'server-issued token C1 decrement',
    });

    await expect(
      httpCall(env, 'increment_public_mine', [1, 'it-token-public'], token),
    ).rejects.toThrow();
    await expect(
      httpCall(env, 'increment_private_mine', [1, 'it-token-private'], token),
    ).rejects.toThrow();
    await expect(
      httpCall(env, 'increment_global', [1, 'it-invalid-token'], 'not-a-jwt'),
    ).rejects.toThrow();
    expect(await globalValue(env)).toBe(before + 1);
  });

  googleTest(
    'accepts a real Google ID token for C2/C3 and isolates the private view',
    async () => {
      const token = googleToken!;
      const payload = decodeJwtPayload(token);
      const email = payload.email;
      if (typeof email !== 'string' || email.length === 0) {
        throw new Error('PERMISSIONS_GOOGLE_ID_TOKEN must contain an email claim');
      }
      const suffix = Date.now().toString(36);
      const savedAnonymousToken = await anonymousToken(env);

      await httpCall(env, 'increment_public_mine', [5, `it-google-pub-${suffix}`], token);
      await env.waitFor(
        async () =>
          (await publicRows(env)).some(
            (row) =>
              row.counter_kind === 'publicOwned' &&
              unwrapOption(row.owner_email) === email &&
              asNumber(row.value) === 5,
          ),
        { description: 'Google-owned C2 public row' },
      );

      await httpCall(env, 'decrement_public_mine', [2, `it-google-dec-${suffix}`], token);
      await env.waitFor(
        async () =>
          (await publicRows(env)).some(
            (row) =>
              row.counter_kind === 'publicOwned' &&
              unwrapOption(row.owner_email) === email &&
              asNumber(row.value) === 3,
          ),
        { description: 'Google-owned C2 decrement' },
      );

      await httpCall(env, 'reset_public_mine', [`it-google-reset-${suffix}`], token);
      await httpCall(env, 'increment_private_mine', [7, `it-google-priv-${suffix}`], token);

      const mine = await httpSql(env, 'SELECT * FROM counter_private_summary', token);
      expect(mine).toHaveLength(1);
      expect(mine[0]?.counter_kind).toBe('privateOwned');
      expect(unwrapOption(mine[0]?.owner_email)).toBe(email);
      expect(asNumber(mine[0]?.value)).toBe(7);

      expect(
        await httpSql(env, 'SELECT * FROM counter_private_summary', savedAnonymousToken),
      ).toEqual([]);
      expect(
        (await publicRows(env)).some((row) => row.counter_kind === 'privateOwned'),
      ).toBe(false);
      await expect(
        httpCall(env, 'increment_public_mine', [1, `it-google-intruder-${suffix}`], savedAnonymousToken),
      ).rejects.toThrow();
    },
  );
});
