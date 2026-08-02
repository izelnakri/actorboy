import { module, test } from 'qunitx';
import { workerPool, PoolNotReady } from '../../lib/node/worker-pool.ts';

const BROKEN = new URL('../fixtures/broken-worker.ts', import.meta.url);

// A pool whose threads cannot boot used to have three separate ways of ruining the process that
// hosted it: the thread's error was re-thrown on the HOST (no 'error' listener, so one bad user
// module killed everything), the slot was re-armed forever (an event-loop handle that can never
// go away, so the process could not exit either), and `ready()` resolved anyway — reporting a
// working pool with nothing in it. All three are covered here.
module('Node | workerPool | a thread that will not boot', () => {
  test('the host survives, the slot gives up, and ready() names the shortfall', async (assert) => {
    if ('Deno' in globalThis) {
      assert.true(true, 'skipped under Deno — worker_threads is the node lane');
      return;
    }
    const pool = workerPool({
      size: 1,
      module: BROKEN,
      group: 'broken',
      // Short on purpose: the module throws on import, so no thread can ever join and waiting the
      // full default would only make the suite slower to reach the same answer.
      readyTimeoutMs: 2_000,
    });
    try {
      const outcome = await pool.ready().result();

      assert.true(PoolNotReady.is(outcome), 'ready() fails rather than resolving on an empty pool');
      if (PoolNotReady.is(outcome)) {
        assert.strictEqual(outcome.data.joined, 0, 'no thread ever joined the group');
        assert.strictEqual(outcome.data.size, 1, 'and the pool reports what it was asked for');
      }
    } finally {
      await pool.stop();
    }

    // Reaching this line is the assertion that matters most: before the pool handled 'error', the
    // worker's throw was re-raised on this thread and took the process down mid-test.
    assert.true(true, 'the worker-thread failure did not propagate to the host');
  });
});
