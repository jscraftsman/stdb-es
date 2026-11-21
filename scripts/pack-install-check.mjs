#!/usr/bin/env node
/**
 * Packs this workspace and installs the tarball into a fresh npm-workspace app.
 *
 * The check verifies that the published `exports` map resolves from both a
 * module-like and web-like workspace, that the shipped declarations typecheck,
 * and that the browser-safe runtime entry points load without this repository's
 * dev setup. The server entry is typechecked only; it requires the SpacetimeDB
 * host to load at runtime.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmExecPath = process.env.npm_execpath;
const npmFallback = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const tempRoot = process.env.RUNNER_TEMP ?? os.tmpdir();
const temp = fs.mkdtempSync(path.join(tempRoot, 'stdb-es-pack-'));

// `npm run` exports npm_config_allow_scripts into this process. Passing that
// inherited value into the fresh install makes npm 11 reject the project-scoped
// install, so drop it for child npm calls. `npm publish --dry-run` also exports
// npm_config_dry_run; leaving it set would make `npm pack` report a tarball name
// without writing the file, which breaks the install below.
const npmEnv = { ...process.env };
delete npmEnv.npm_config_allow_scripts;
delete npmEnv.npm_config_dry_run;
delete npmEnv['npm_config_dry-run'];

function npmInvocation(args) {
  return npmExecPath
    ? { command: process.execPath, args: [npmExecPath, ...args], shell: false }
    : { command: npmFallback, args, shell: process.platform === 'win32' };
}

function write(relativePath, contents) {
  const target = path.join(temp, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function writeJson(relativePath, value) {
  write(relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, cwd, options = {}) {
  const { env = process.env, ...spawnOptions } = options;
  console.log(`  $ ${[command, ...args].join(' ')}`);
  execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
    env,
    ...spawnOptions,
  });
}

function runNpm(args, cwd) {
  const npm = npmInvocation(args);
  run(npm.command, npm.args, cwd, { shell: npm.shell, env: npmEnv });
}

try {
  console.log('Packing stdb-es...');
  const npmPack = npmInvocation(['pack', '--pack-destination', temp, '--json']);
  const packed = JSON.parse(
    execFileSync(npmPack.command, npmPack.args, {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: npmPack.shell,
      env: npmEnv,
    }),
  );
  // npm 10 reports an array; npm 11 reports an object keyed by package name.
  const packedEntries = Array.isArray(packed) ? packed : Object.values(packed);
  const filename = packedEntries[0]?.filename;
  if (!filename) throw new Error('npm pack did not report a tarball');
  const dependency = pathToFileURL(path.join(temp, filename)).href;

  const sharedTsconfig = {
    compilerOptions: {
      target: 'ES2022',
      lib: ['ES2022', 'DOM'],
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: true,
      verbatimModuleSyntax: true,
      noEmit: true,
    },
    include: ['src'],
  };

  writeJson('package.json', {
    name: 'stdb-es-pack-check',
    private: true,
    version: '0.0.0',
    type: 'module',
    workspaces: ['module', 'web', 'node'],
    devDependencies: { typescript: '^5.7.0' },
  });

  writeJson('module/package.json', {
    name: 'pack-check-module',
    private: true,
    version: '0.0.0',
    type: 'module',
    dependencies: { 'stdb-es': dependency, spacetimedb: '2.15.0' },
  });
  writeJson('module/tsconfig.json', sharedTsconfig);
  write(
    'module/src/index.ts',
    [
      "import { streamId } from 'stdb-es';",
      "import { ANY_VERSION } from 'stdb-es/server';",
      "import { createFakeAppend, createFakeCommand, createModuleTest, ids } from 'stdb-es/testing';",
      '',
      "export const id = streamId('check', '1');",
      'export const version = ANY_VERSION;',
      "export const eventIds = ids('check', 2);",
      'export const append = createFakeAppend();',
      'export const command = createFakeCommand();',
      'export { createModuleTest };',
      '',
    ].join('\n'),
  );

  writeJson('web/package.json', {
    name: 'pack-check-web',
    private: true,
    version: '0.0.0',
    type: 'module',
    dependencies: { 'stdb-es': dependency, spacetimedb: '2.15.0' },
  });
  writeJson('web/tsconfig.json', sharedTsconfig);
  write(
    'web/src/index.ts',
    [
      "import { streamId } from 'stdb-es';",
      "import { sqlString, subscribeEventRows, tableQuery } from 'stdb-es/client';",
      "import { createCommandClient, withCommandId } from 'stdb-es/client';",
      '',
      "export const id = streamId('check', '1');",
      "export const query = tableQuery('counter_summary');",
      "export const literal = sqlString('O\\'Brien');",
      'export const subscribe = subscribeEventRows;',
      "export const command = withCommandId({ counterId: 'check-1', by: 1 }, { commandId: 'cmd-1' });",
      'export const dispatch = createCommandClient;',
      '',
    ].join('\n'),
  );

  writeJson('node/package.json', {
    name: 'pack-check-node',
    private: true,
    version: '0.0.0',
    type: 'module',
    dependencies: { 'stdb-es': dependency, spacetimedb: '2.15.0' },
  });
  writeJson('node/tsconfig.json', sharedTsconfig);
  write(
    'node/src/index.ts',
    [
      "import { createIntegrationEnv, integrationDatabase } from 'stdb-es/testing/integration';",
      '',
      'export const makeEnv = createIntegrationEnv;',
      'export const database = integrationDatabase();',
      '',
    ].join('\n'),
  );

  write(
    'verify.mjs',
    [
      "import { streamId } from 'stdb-es';",
      "import { tableQuery, withCommandId } from 'stdb-es/client';",
      '',
      "if (streamId('check', '1') !== 'check-1') throw new Error('root export failed');",
      "if (tableQuery('counter_summary') !== 'SELECT * FROM counter_summary') {",
      "  throw new Error('client export failed');",
      '}',
      "if (withCommandId({ counterId: 'check-1' }, { commandId: 'cmd-1' }).commandId !== 'cmd-1') {",
      "  throw new Error('command export failed');",
      '}',
      "console.log('  packed browser-safe entry points resolve');",
      '',
    ].join('\n'),
  );

  console.log('Installing into a fresh workspace app...');
  runNpm(['install', '--no-audit', '--no-fund'], temp);
  runNpm(['exec', '--', 'tsc', '-p', 'module/tsconfig.json', '--noEmit'], temp);
  runNpm(['exec', '--', 'tsc', '-p', 'web/tsconfig.json', '--noEmit'], temp);
  runNpm(['exec', '--', 'tsc', '-p', 'node/tsconfig.json', '--noEmit'], temp);
  run(process.execPath, ['verify.mjs'], temp);

  console.log(`Fresh-app pack check passed (${filename}).`);
} catch (error) {
  console.error('Fresh-app pack check failed.');
  console.error(error);
  process.exitCode = 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
