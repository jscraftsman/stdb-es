/**
 * Builds a subscription query for an app-owned view.
 *
 * Views are the only client-visible surface for private event data, so this
 * helper targets views, not `es_event`. Arguments are SQL literals: escape
 * strings and serialize bigints explicitly.
 */
export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A value accepted as a parameterized-view argument. */
export type SqlLiteral = string | number | bigint | boolean | null;

export function sqlLiteral(value: SqlLiteral): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`invalid SQL literal: ${value}`);
    return value.toString();
  }
  return sqlString(value);
}

/**
 * Builds a `SELECT * FROM <view>(args...)` query for a parameterized view.
 *
 * SpacetimeDB has no typed query builder for view arguments, so callers pass
 * literal values in the same order as the view's parameters.
 */
export function viewQuery(name: string, args: readonly SqlLiteral[] = []): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`invalid view name: ${name}`);
  }
  const list = args.length === 0 ? '' : args.map(sqlLiteral).join(', ');
  return `SELECT * FROM ${name}(${list})`;
}

/** Builds a plain table subscription query, e.g. for an app read model. */
export function tableQuery(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`invalid table name: ${name}`);
  }
  return `SELECT * FROM ${name}`;
}
