/**
 * Benchmarks the distribution layer over the in-memory hub.
 *
 * The memory hub is the transport with no I/O in it, which is exactly what makes it the
 * right substrate here: what remains is the framing, the ref bookkeeping and the Failure
 * envelope codec — the per-message cost this library adds on top of whatever wire you
 * actually use. A regression in these numbers is a regression in every transport at once.
 *
 * The `failure` group is the one that justifies the whole design: a declared failure crossing
 * a node boundary must arrive declared, not as a clone-gutted Error. That round-trip costs a
 * serialize + a revive, and this is where that price is kept visible.
 */
import * as Node from '../lib/node/index.ts';
import * as Failure from '../lib/result/failure.ts';

const NotFound = Failure.define('NotFound', (data: { id: number }) => `no user ${data.id}`);

const hub = Node.memoryHub();
const client = Node.start('client@bench', hub.transport());
const server = Node.start('server@bench', hub.transport());

server.handle('echo', (payload) => payload);
server.handle('add', (payload) => (payload as number[]).reduce((a, b) => a + b, 0));
server.handle('missing', (payload) => NotFound({ id: payload as number }));

// Hellos ride microtasks; one turn is enough for both nodes to see each other before the
// first measured call.
await new Promise((resolve) => setTimeout(resolve, 10));

const SMALL = { id: 1, name: 'ada' };
const LARGE = Array.from({ length: 500 }, (_, index) => ({ id: index, name: `user-${index}` }));

Deno.bench('node: call round-trip, small payload', { group: 'call' }, async () => {
  await client.call('server@bench', 'echo', SMALL, 1000);
});

// The memory hub hands the payload across by reference — no clone, no codec. Benched beside
// the small payload precisely so that stays true: the day this diverges, something started
// serialising on a transport whose whole purpose is not to.
Deno.bench('node: call round-trip, 500-row payload', { group: 'call' }, async () => {
  await client.call('server@bench', 'echo', LARGE, 1000);
});

Deno.bench('node: call with work on the far side', { group: 'call' }, async () => {
  await client.call('server@bench', 'add', [1, 2, 3, 4, 5], 1000);
});

// `.result()`, not a bare await: a declared failure rejects the call Task, and settling it to
// the bare `T | E` union is what a real consumer does before branching on it.
Deno.bench('node: a declared failure crossing the wire', { group: 'failure' }, async () => {
  await client.call('server@bench', 'missing', 7, 1000).result();
});

// cast is fire-and-forget: no ref, no reply, no deadline. It should be a small fraction of a
// call, and this pair is what says so.
Deno.bench('node: cast (no reply expected)', { group: 'cast' }, () => {
  client.cast('server@bench', 'echo', SMALL);
});

Deno.bench('node: list peers', { group: 'membership' }, () => {
  client.list();
});
