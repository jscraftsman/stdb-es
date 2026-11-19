import type { IntegrationWaitOptions } from './types.js';

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: IntegrationWaitOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    if (await predicate()) return;
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${options.description ?? 'integration condition'}`,
  );
}
