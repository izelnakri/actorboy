// A workerPool worker module — runs inside a worker thread. In test/fixtures (lint/check excluded).
// Pure: it `export`s a `worker` setup; the pool's bootstrap hands it to serveWorker().
import type { NodeHandle } from '../../lib/node/node.ts';

export function worker(node: NodeHandle) {
  const fib = (n: number): number => (n < 2 ? n : fib(n - 1) + fib(n - 2));
  node.handle('fib', (payload) => fib(payload as number)); // CPU-heavy, on this thread
  node.handle('echo', (payload) => payload);
  // Sleeps past `call`'s 5s default so a delegated call proves it inherited the caller's budget
  // rather than the default — the CI failure this fixture's `fib` only reproduced on a slow box.
  node.handle(
    'slow',
    (payload) => new Promise((r) => setTimeout(() => r('done'), payload as number)),
  );
  node.handle('crash', () => void setTimeout(() => process.exit(1), 0)); // kill this worker thread
}
