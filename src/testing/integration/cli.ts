import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  IntegrationJson,
  IntegrationRow,
  IntegrationSqlResult,
  IntegrationStatement,
} from './types.js';

const execFile = promisify(execFileCallback);

export async function runCli(
  args: readonly string[],
  cwd: string,
): Promise<string> {
  try {
    const { stdout } = await execFile('spacetime', [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const failure = error as { message?: string; stdout?: string; stderr?: string };
    const detail = [failure.stderr, failure.stdout, failure.message]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join('\n')
      .trim();
    throw new Error(`spacetime ${args[0] ?? ''} failed: ${detail || 'unknown error'}`);
  }
}

function columnNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((element) => {
      const name = (element as { name?: { some?: unknown } })?.name?.some;
      return typeof name === 'string' ? name : undefined;
    })
    .filter((name): name is string => name !== undefined);
}

/** Parses `spacetime sql --format json` output into row objects. */
export function parseSqlResult(output: string): IntegrationSqlResult {
  const parsed: unknown = JSON.parse(output);
  const rawStatements = Array.isArray(parsed) ? parsed : [parsed];

  const statements: IntegrationStatement[] = rawStatements.map((statement) => {
    const raw = statement as {
      schema?: { elements?: unknown };
      rows?: unknown;
    };
    const columns = columnNames(raw.schema?.elements);
    const rows = Array.isArray(raw.rows)
      ? raw.rows.map((row): IntegrationRow => {
          if (!Array.isArray(row)) return row as IntegrationRow;
          return Object.fromEntries(
            columns.map((column, index) => [column, row[index] as IntegrationJson]),
          );
        })
      : [];
    return { columns, rows };
  });

  return {
    rows: statements[0]?.rows ?? [],
    statements,
  };
}

/** Formats CLI positional arguments. Objects and arrays become one JSON token each. */
export function cliArgs(args?: object | readonly unknown[]): string[] {
  if (args === undefined) return [];
  if (Array.isArray(args)) return args.map((value) => JSON.stringify(value));
  return [JSON.stringify(args)];
}
