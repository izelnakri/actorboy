import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { workerPool, dirtyDelegate } from '../../lib/node/worker-pool.ts';

const CPU_WORKER = new URL('../fixtures/cpu-worker.ts', import.meta.url);

module('Node | dirtyDelegate (CPU offload to a pool thread)', () => {
  test('a delegated CPU subject computes on a thread, off the main loop', async (assert) => {
    if ('Deno' in globalThis) {
      assert.true(true, 'skipped under Deno — worker_threads is the node lane');
      return;
    }
    const hub = Node.memoryHub();
    const gateway = Node.start('gw@dirty', hub.transport());
    const client = Node.start('cli@dirty', hub.transport());
    const pool = workerPool({ size: 2, module: CPU_WORKER, group: 'cpu' });
    try {
      await pool.ready();
      // The gateway exposes 'fib' but runs it on a pool thread rather than its own loop.
      dirtyDelegate(gateway, pool, ['fib']);

      // While a heavy compute runs, the main loop must keep ticking — proof it went to a thread.
      let ticks = 0;
      const ticker = setInterval(() => (ticks += 1), 1);
      // Cleared in a `finally`, because a 1ms interval that outlives a throwing await holds the
      // event loop open for good: this test failed on a slow runner and then hung the whole job
      // until its 15-minute timeout, with the interval — not the pool — keeping node alive.
      const result = await client
        .call('gw@dirty', 'fib', 38, 20000)
        .finally(() => clearInterval(ticker));

      assert.strictEqual(result, 39088169, 'fib(38) computed on a pool thread');
      assert.true(ticks > 5, `the main loop ticked ${ticks}x during the compute — not blocked`);
    } finally {
      await pool.stop();
      gateway.stop();
      client.stop();
    }
  });
});

// The delegated hop used to take `node.call`'s 5s default however long the root caller allowed —
// an ambient deadline caps a nested call but never raises one, and the pool answers on its own
// coordinator node, which cannot read the calling node's ambient context. On a fast machine
// `fib(38)` lands well inside 5s and hid it; CI is where a delegated compute crosses the line.
module('Node | dirtyDelegate | the caller owns the budget', () => {
  test('a delegated call outliving the 5s default succeeds on the caller’s timeout', async (assert) => {
    if ('Deno' in globalThis) {
      assert.true(true, 'skipped under Deno — worker_threads is the node lane');
      return;
    }
    const hub = Node.memoryHub();
    const gateway = Node.start('gw@budget', hub.transport());
    const client = Node.start('cli@budget', hub.transport());
    const pool = workerPool({ size: 1, module: CPU_WORKER, group: 'budget' });
    try {
      await pool.ready();
      dirtyDelegate(gateway, pool, ['slow']);

      // 6s of work, 15s allowed: only fails if the hop imposes its own 5s default.
      const outcome = await client.call('gw@budget', 'slow', 6_000, 15_000).result();

      assert.strictEqual(
        outcome,
        'done',
        'the pool hop inherited the 15s budget, not the 5s default',
      );
    } finally {
      await pool.stop();
      gateway.stop();
      client.stop();
    }
  });
});
