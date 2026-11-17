import { Range } from 'spacetimedb/server';

/**
 * Test-harness workaround for `spacetimedb@2.15.0`.
 *
 * The module test harness bundles its own copy of the `Range` class, so the
 * `range instanceof Range` check inside `makeTableView` fails for ranges created
 * by module code. Composite scans then silently degrade to point scans and
 * single-column range scans throw `Cannot convert [object Object] to a BigInt`.
 * The real host is unaffected (verified against a live database), so production
 * code keeps the fast indexed path unmodified.
 *
 * Wrap reducer and view contexts in tests until the harness ships a fix.
 * Delete this file once it does.
 */

/** Any iterable index accessor: point, prefix, or range scan. */
type IndexAccessor = {
  filter: (scan: unknown) => Iterable<EventRow>;
  delete?: (scan: unknown) => number;
};

type EventRow = Record<string, any>;

type IndexShim = {
  table: string;
  /** Indexed column names, in index order. */
  columns: readonly string[];
};

const EVENT_INDEXES: Record<string, IndexShim> = {
  byStreamVersion: { table: 'esEvent', columns: ['streamId', 'version'] },
  byStreamTime: { table: 'esEvent', columns: ['streamId', 'createdAtMicros'] },
  byPosition: { table: 'esEvent', columns: ['position'] },
};

type Bound =
  | { tag: 'included'; value: unknown }
  | { tag: 'excluded'; value: unknown }
  | { tag: 'unbounded' };

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    const left = BigInt(a as bigint);
    const right = BigInt(b as bigint);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return a! < b! ? -1 : a! > b! ? 1 : 0;
}

function inBounds(value: unknown, from: Bound, to: Bound): boolean {
  if (from.tag === 'included' && compare(value, from.value) < 0) return false;
  if (from.tag === 'excluded' && compare(value, from.value) <= 0) return false;
  if (to.tag === 'included' && compare(value, to.value) > 0) return false;
  if (to.tag === 'excluded' && compare(value, to.value) >= 0) return false;
  return true;
}

/**
 * Evaluates one library-style scan against in-memory rows.
 *
 * Supports the forms the SDK types allow:
 * - single-column: `value` or `Range`
 * - composite: a prefix of values, optionally ending in a `Range`
 */
function scanRows(
  rows: readonly EventRow[],
  columns: readonly string[],
  scan: unknown,
): EventRow[] {
  const terms = Array.isArray(scan) ? scan : [scan];
  if (terms.length > columns.length) {
    throw new TypeError(`index scan has ${terms.length} terms for ${columns.length} columns`);
  }

  return rows
    .filter((row) => {
      for (let i = 0; i < terms.length; i += 1) {
        const term = terms[i];
        const value = row[columns[i]!];
        if (term instanceof Range) {
          return inBounds(value, term.from as Bound, term.to as Bound);
        }
        if (compare(value, term) !== 0) return false;
      }
      return true;
    })
    .sort((a, b) => {
      for (const column of columns) {
        const order = compare(a[column], b[column]);
        if (order !== 0) return order;
      }
      return 0;
    });
}

function shimIndex(
  accessor: IndexAccessor,
  rows: () => readonly EventRow[],
  columns: readonly string[],
): IndexAccessor {
  return {
    ...accessor,
    filter: (scan: unknown) => scanRows(rows(), columns, scan),
  };
}

/**
 * Wraps a reducer, view, or procedure context so the library's indexed range
 * scans run against an in-memory index instead of the harness's broken one.
 */
export function withIndexRanges<C extends { readonly db: Record<string, any> }>(ctx: C): C {
  const db = ctx.db;
  const event = db.esEvent;
  if (!event || event.__rangeShim) return ctx;

  const rows = () => [...event.iter()] as EventRow[];
  const shimmedEvent = Object.assign(Object.create(null), event);
  for (const [name, shim] of Object.entries(EVENT_INDEXES)) {
    if (shim.table !== 'esEvent') continue;
    const accessor = event[name] as IndexAccessor | undefined;
    if (!accessor) continue;
    shimmedEvent[name] = shimIndex(accessor, rows, shim.columns);
  }
  Object.defineProperty(shimmedEvent, '__rangeShim', { value: true });

  const shimmedDb = Object.assign(Object.create(null), db, { esEvent: shimmedEvent });

  // Delegate every property to the original context. The proxy target is a
  // throwaway plain object, so there are no property invariants to violate, and
  // methods run with the real context as `this` (private class fields like
  // `#random` are declared on that instance, not on a proxy).
  return new Proxy({} as C, {
    get(_target, property) {
      if (property === 'db') return shimmedDb;
      const value = (ctx as Record<PropertyKey, any>)[property];
      return typeof value === 'function'
        ? (...args: unknown[]) => value.apply(ctx, args)
        : value;
    },
    has(_target, property) {
      return property === 'db' || property in (ctx as object);
    },
  });
}
