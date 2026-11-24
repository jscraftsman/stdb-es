import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const srcRoot = join(repoRoot, 'src');
const frontendEntries = [join(srcRoot, 'index.ts'), join(srcRoot, 'client', 'index.ts')];
const integrationEntry = join(srcRoot, 'testing', 'integration', 'index.ts');
const integrationDir = join(srcRoot, 'testing', 'integration');

const forbiddenFrameworkModule =
  /^(react|react-dom|preact|vue|svelte|solid-js|phaser|spacetimedb\/react)(\/|$)|^@angular\//;
const forbiddenNodeModule =
  /^node:|^child_process$|^crypto$|^fs$|^net$|^os$|^path$|^process$|^util$/;
const forbiddenBrowserGlobal =
  /\b(window|document|localStorage|sessionStorage|navigator|HTMLElement|Element|JSX)\b/;
const forbiddenNodeGlobal = /\b(Buffer|__dirname|__filename)\b|\bprocess\s*\.|\brequire\s*\(/;

function sourceFilesIn(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFilesIn(path));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(path);
  }
  return files;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function stripCommentsAndStrings(source: string): string {
  return stripComments(source).replace(
    /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g,
    "''",
  );
}

function importSpecifiers(source: string): string[] {
  const stripped = stripComments(source);
  return [...stripped.matchAll(/(?:\bfrom\s+|\bimport\s*)['"]([^'"]+)['"]/g)].map(
    (match) => match[1] as string,
  );
}

function resolveSourceFile(fromFile: string, specifier: string): string | null {
  const target = resolve(dirname(fromFile), specifier.replace(/\.js$/, '.ts'));
  if (existsSync(target)) return target;

  const index = join(target, 'index.ts');
  return existsSync(index) ? index : null;
}

function graphFrom(entry: string) {
  const files = new Set<string>();
  const modules = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (files.has(file)) continue;
    files.add(file);

    const source = readFileSync(file, 'utf8');
    for (const specifier of importSpecifiers(source)) {
      modules.add(specifier);
      if (!specifier.startsWith('.')) continue;

      const next = resolveSourceFile(file, specifier);
      if (next) queue.push(next);
    }
  }

  return { files, modules };
}

describe('frontend-framework neutrality', () => {
  it('keeps framework imports out of the shared source tree', () => {
    const problems: string[] = [];
    for (const file of sourceFilesIn(srcRoot)) {
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (forbiddenFrameworkModule.test(specifier)) {
          problems.push(`${relative(repoRoot, file)} imports ${specifier}`);
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it('keeps JSX out of the shared source tree', () => {
    const jsxFiles = sourceFilesIn(srcRoot).filter((file) => file.endsWith('.tsx'));
    expect(jsxFiles.map((file) => relative(repoRoot, file))).toEqual([]);
  });

  it('keeps framework and Node-only modules out of the frontend entry graphs', () => {
    const problems: string[] = [];
    for (const entry of frontendEntries) {
      const { modules } = graphFrom(entry);
      for (const specifier of modules) {
        if (forbiddenFrameworkModule.test(specifier)) {
          problems.push(`${relative(repoRoot, entry)} -> ${specifier} (framework)`);
        }
        if (forbiddenNodeModule.test(specifier)) {
          problems.push(`${relative(repoRoot, entry)} -> ${specifier} (Node-only)`);
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it('keeps browser and Node globals out of the frontend entry graphs', () => {
    const problems: string[] = [];
    for (const entry of frontendEntries) {
      const { files } = graphFrom(entry);
      for (const file of files) {
        const code = stripCommentsAndStrings(readFileSync(file, 'utf8'));
        const name = relative(repoRoot, file);
        if (forbiddenBrowserGlobal.test(code)) problems.push(`${name} (browser global)`);
        if (forbiddenNodeGlobal.test(code)) problems.push(`${name} (Node global)`);
      }
    }

    expect(problems).toEqual([]);
  });

  it('imports the public entry points without DOM globals', async () => {
    const globals = globalThis as Record<string, unknown>;
    expect(globals.window).toBeUndefined();
    expect(globals.document).toBeUndefined();
    expect(globals.localStorage).toBeUndefined();

    const shared = await import('../src/index.js');
    const client = await import('../src/client/index.js');

    expect(typeof shared.streamId).toBe('function');
    expect(typeof client.createCommandClient).toBe('function');
    expect(typeof client.newCommandId).toBe('function');
  });

  it('declares Vitest as a required peer for the unit kit', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };

    expect(manifest.peerDependencies?.vitest).toBe('>=3 <4');
    expect(manifest.peerDependenciesMeta?.vitest?.optional).not.toBe(true);
  });
});

describe('integration kit boundary', () => {
  it('is not reachable from a frontend entry graph', () => {
    const leaked = new Set<string>();
    for (const entry of frontendEntries) {
      const { files } = graphFrom(entry);
      for (const file of files) {
        if (file === integrationEntry || file.startsWith(`${integrationDir}${sep}`)) {
          leaked.add(file);
        }
      }
    }

    expect([...leaked].map((file) => relative(repoRoot, file))).toEqual([]);
  });

  it('keeps Node/CLI modules inside the integration entry graph', () => {
    const { files, modules } = graphFrom(integrationEntry);
    const nodeModules = [...modules].filter((specifier) => specifier.startsWith('node:'));

    expect(nodeModules.length).toBeGreaterThan(0);
    expect([...files].map((file) => relative(repoRoot, file))).toContain(
      join('src', 'testing', 'integration', 'env.ts'),
    );
  });

  it('keeps browser globals out of the integration entry graph', () => {
    const problems: string[] = [];
    const { files } = graphFrom(integrationEntry);
    for (const file of files) {
      const code = stripCommentsAndStrings(readFileSync(file, 'utf8'));
      if (forbiddenBrowserGlobal.test(code)) problems.push(relative(repoRoot, file));
    }

    expect(problems).toEqual([]);
  });
});
