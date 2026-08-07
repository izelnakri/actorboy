#!/usr/bin/env node
// Consumer smoke test: packs the tarball, installs it into a throwaway project, and imports
// every entry point of the exports map from OUTSIDE the package — the one thing the in-repo
// suites structurally cannot check, because they import `lib/**/*.ts` directly and never see
// `dist/`, the exports map, or the `.ts`→`.js` specifier rewrite that makes them resolvable.
//
// Run after `npm run build`. Requires no network: the tarball is installed from disk.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';
const STDIO = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] };
// On Windows npm is a `.cmd` shim, which node refuses to spawn without a shell
// (CVE-2024-27980) — and a shell re-splits every argument on whitespace, so the paths we hand
// it go through quoted. The `node consumer.js` call below needs neither and gets neither.
const npmRun = (args, cwd) =>
  execFileSync(IS_WINDOWS ? 'npm.cmd' : 'npm', IS_WINDOWS ? args.map(shellQuoted) : args, {
    ...STDIO,
    cwd,
    shell: IS_WINDOWS,
  });

// The consumer: one import per entry point, then a live exercise of each leg. `ws` is absent
// here on purpose — `actorboy/node/hub` is the only entry that needs it, and leaving it
// out proves the other seven stay installable with zero dependencies.
const CONSUMER = `
import { Result, Task, Stream, Supervisor, Node, Failure } from 'actorboy';
import * as ResultEntry from 'actorboy/result';
import * as FailureEntry from 'actorboy/failure';
import { Task as TaskEntry } from 'actorboy/task';
import { Stream as StreamEntry } from 'actorboy/stream';
import * as SupervisorEntry from 'actorboy/supervisor';
import * as NodeEntry from 'actorboy/node';
import assert from 'node:assert';

const NotFound = Failure.define('NotFound', (d) => \`no user \${d.id}\`);

const parsed = Result.try(JSON.parse, '{"n":1}');
assert.ok(parsed.ok && parsed.value.n === 1);
assert.equal(await Task(() => 21).map((n) => n * 2), 42);
assert.deepEqual(await Stream.from([1, 2, 3]).map((n) => n * 2).collect(), [2, 4, 6]);

const failed = await Task(() => { throw NotFound({ id: 7 }); }).result();
assert.ok(Failure.is(failed) && failed.code === 'NotFound');

const tree = Supervisor.start([{ id: 'w', restart: 'temporary', start: () => 'ran' }]);
await tree.stop();

const hub = Node.memoryHub();
const a = Node.start('a@memory', hub.transport());
const b = Node.start('b@memory', hub.transport());
b.handle('echo', (x) => x);
assert.equal(await a.call('b@memory', 'echo', 7, 1000), 7);
a.stop();
b.stop();

// The subpath entries must be the same modules as the root barrel's, not second copies.
assert.equal(TaskEntry, Task);
assert.equal(StreamEntry, Stream);
assert.equal(ResultEntry.unwrap, Result.unwrap);
assert.equal(FailureEntry.define, Failure.define);
assert.equal(SupervisorEntry.start, Supervisor.start);
assert.equal(NodeEntry.start, Node.start);

console.log('smoke-package: OK');
`;

const projectRoot = path.resolve(import.meta.dirname, '..');
const workspace = await mkdtemp(path.join(tmpdir(), 'actorboy-smoke-'));
try {
  npmRun(['pack', '--pack-destination', workspace, '--ignore-scripts'], projectRoot);
  const [tarball] = (await readdir(workspace)).filter((name) => name.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack produced no tarball');

  await writeFile(
    path.join(workspace, 'package.json'),
    JSON.stringify({ name: 'consumer', private: true, type: 'module' }, null, 2),
  );
  await writeFile(path.join(workspace, 'consumer.js'), CONSUMER);
  npmRun(['install', '--no-audit', '--no-fund', tarball], workspace);
  process.stdout.write(
    execFileSync(process.execPath, ['consumer.js'], { ...STDIO, cwd: workspace }),
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}

/** Whitespace and quotes are the only characters `shell: true` would re-split a path on. */
function shellQuoted(argument) {
  return /[\s"]/.test(argument) ? `"${argument.replaceAll('"', '\\"')}"` : argument;
}
