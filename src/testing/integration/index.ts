/**
 * Node/CLI-only integration harness.
 *
 * This entry starts the SpacetimeDB CLI and uses Node built-ins. Import it from tests and CI only;
 * frontend bundles should use `stdb-es/client` instead.
 */
export { createIntegrationEnv, integrationDatabase } from './env.js';
export type {
  CreateIntegrationEnvOptions,
  IntegrationCallOptions,
  IntegrationClient,
  IntegrationConnectOptions,
  IntegrationEnv,
  IntegrationJson,
  IntegrationRow,
  IntegrationSqlOptions,
  IntegrationSqlResult,
  IntegrationStatement,
  IntegrationWaitOptions,
} from './types.js';
