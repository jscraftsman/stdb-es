/** A JSON value as returned by `spacetime sql --format json`. */
export type IntegrationJson =
  | null
  | string
  | number
  | boolean
  | IntegrationJson[]
  | { readonly [key: string]: IntegrationJson };

/** One SQL row, keyed by column name. Complex SpacetimeDB values stay in CLI JSON form. */
export type IntegrationRow = { readonly [column: string]: IntegrationJson };

export type IntegrationStatement = {
  readonly columns: readonly string[];
  readonly rows: readonly IntegrationRow[];
};

export type IntegrationSqlResult = {
  /** Rows from the first statement. Empty when the query returned no statements. */
  readonly rows: readonly IntegrationRow[];
  readonly statements: readonly IntegrationStatement[];
};

export type IntegrationCallOptions = {
  /** Call through a throwaway anonymous identity instead of the CLI's saved identity. */
  anonymous?: boolean;
};

export type IntegrationSqlOptions = IntegrationCallOptions;

export type IntegrationWaitOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  /** Included in the timeout error to make failures easier to diagnose. */
  description?: string;
};

export type IntegrationConnectOptions = {
  /** Use a throwaway anonymous identity for the subscription connection. */
  anonymous?: boolean;
  /** Initial raw SQL subscriptions. Each starts its own CLI process. */
  queries?: readonly string[];
  /** Include rows already present when a subscription starts. Defaults to `true`. */
  printInitialUpdate?: boolean;
  /** Overrides the environment timeout for this client's `waitFor` calls. */
  timeoutMs?: number;
};

export type IntegrationClient = {
  /** Current rows for one table or view, keyed by the name used in the query result. */
  rows(table: string): readonly IntegrationRow[];
  /** Names currently held in the client-side row cache. */
  tables(): readonly string[];
  /** Starts another live SQL subscription on this client. */
  subscribe(query: string): Promise<void>;
  /** Polls this client's row cache until the predicate succeeds. */
  waitFor(
    predicate: (client: IntegrationClient) => boolean | Promise<boolean>,
    options?: IntegrationWaitOptions,
  ): Promise<void>;
  /** Stops all subscription processes owned by this client. */
  close(): Promise<void>;
};

export type CreateIntegrationEnvOptions = {
  /**
   * `'local'` spawns and owns `spacetime start --in-memory --non-interactive`.
   * A URL or CLI server nickname connects to an existing server.
   */
  server?: string;
  /** Database name. Generated when omitted. */
  database?: string;
  /** Module directory passed to `spacetime publish -p`. Defaults to `spacetimedb`. */
  modulePath?: string;
  /** Working directory for CLI calls. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Publish the module during setup. Defaults to `true`. */
  publish?: boolean;
  /** Publish with `--delete-data=always`. Defaults to `true`. */
  deleteData?: boolean;
  /** Port used by `'local'`. A free port is chosen when omitted. */
  port?: number;
  /**
   * Keep the database during `dispose()` instead of deleting it. Defaults to
   * `false` when publishing and `true` when attaching with `publish: false`.
   */
  keepDatabase?: boolean;
  /** Keep a spawned local server running during `dispose()`. */
  keepServer?: boolean;
  /** Readiness/operation timeout in milliseconds. Defaults to 120000. */
  timeoutMs?: number;
};

export type IntegrationEnv = {
  readonly server: string;
  readonly database: string;
  readonly modulePath: string;
  /** Calls a reducer or procedure through the SpacetimeDB CLI. */
  call(
    name: string,
    args?: object | readonly unknown[],
    options?: IntegrationCallOptions,
  ): Promise<void>;
  /** Runs one SQL statement as the database owner, or anonymously when requested. */
  sql(query: string, options?: IntegrationSqlOptions): Promise<IntegrationSqlResult>;
  /** Starts a live CLI-backed subscription client. */
  connect(options?: IntegrationConnectOptions): Promise<IntegrationClient>;
  /** Polls any condition until it succeeds or the timeout expires. */
  waitFor(
    predicate: () => boolean | Promise<boolean>,
    options?: IntegrationWaitOptions,
  ): Promise<void>;
  /** Closes clients, deletes the database, and stops a spawned server. */
  dispose(): Promise<void>;
};
