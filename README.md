# actorboy

Elixir/OTP's runtime model on web standards, for JavaScript and TypeScript.

Five modules, one failure vocabulary, zero runtime dependencies. Runs unchanged on Node.js,
Deno and in the browser.

| Leg          | What it is                | Elixir counterpart      |
| ------------ | ------------------------- | ----------------------- |
| `Result`     | one settled outcome       | `{:ok, v}` / `{:error, e}` |
| `Task`       | one future outcome        | `Task`                  |
| `Stream`     | many outcomes over time   | `Stream`                |
| `Supervisor` | what keeps producers alive | `Supervisor`           |
| `Node`       | the same vocabulary across a wire | `Node`         |

A `Failure` is the currency all five share: a declared, discriminable, serialisable error
kind. It survives `JSON.stringify`, `structuredClone`, a worker boundary and a WebSocket —
which is what makes distribution and supervision speak the same language as a local `try`.

## Install

```sh
npm install actorboy     # Node, bundlers
deno add jsr:@izelnakri/actorboy
```

## Result — the settled outcome

A success is the **value itself**; a failure is the `Failure`. No box, no tuple, no unwrapping
on the happy path.

```ts
import * as Result from 'actorboy/result';
import * as Failure from 'actorboy/failure';

const NotFound = Failure.define('NotFound', (d: { id: number }) => `no user ${d.id}`);

function loadUser(id: number): Result.Result<{ id: number }, Failure.Of<typeof NotFound>> {
  return id > 0 ? { id } : NotFound({ id });
}

const user = loadUser(7);
if (Failure.is(user)) console.error(user.code); // 'NotFound' — narrowed on both branches
```

`Result.try(fn, ...args)` is the one place the `try`/`catch` keyword lives: it takes
`Promise.try`'s shape and reflects a throw into `{ ok, value, error }`.

## Task — the future outcome

A **lazy, retryable** `Promise` superset. `instanceof Promise` holds and it passes the
official Promises/A+ suite (872 tests), so `await`, `Promise.all` and `try`/`catch` all work —
but the recipe does not run until something awaits it, and it can be re-run.

```ts
import { Task, Failure } from 'actorboy/task'; // one leg, one import — Failure rides along

const Unreachable = Failure.define('Unreachable', (d: { id: number }) => `user ${d.id} is out`);

const profile = Task(() => fetch(`/users/${id}`))
  .mapErr((cause) => Unreachable({ id }, { cause })) // classify at the adapter edge
  .map((response) => response.json())
  .retry(2); // three fresh executions of the WHOLE chain, at most

const outcome = await profile.result(); // the bare union — value, or the declared Failure
```

Declared failures are values a caller planned for; anything else is a bug that keeps flying to
one crash boundary. `result`, `match`, `unwrapOr` and `expect` act only on the first kind.

Elixir's `Task` API is there too: `Task.async`/`await`, `yield`, `shutdown`, `completed`,
`asyncStream`.

## Stream — many outcomes over time

A lazy async pipeline whose elements are the same bare union, and whose terminal consumers
return Tasks.

```ts
import { Stream } from 'actorboy/stream';

const { values, errors } = await Stream.from(sources)
  .map(fetchReport)
  .partition(); // successes and failures kept together, not discarded
```

## Supervisor — keeping producers alive

OTP supervision for in-process JS: the three restart policies, the three strategies, and a
restart-intensity budget that ends the tree loudly rather than restarting forever.
`Supervisor.dynamic()` is OTP's `DynamicSupervisor` — children started and stopped at runtime,
under the same intensity budget.

```ts
import * as Supervisor from 'actorboy/supervisor';

const tree = Supervisor.start(
  [
    { id: 'ingest', start: (signal) => ingestLoop(signal) }, // permanent by default
    { id: 'reporter', restart: 'transient', start: (signal) => report(signal) },
  ],
  { strategy: 'restForOne', maxRestarts: 3, maxSeconds: 5 },
);

await tree.done; // settles only when supervision ENDS
```

## Node — the cluster

Elixir's `Node`, JS-shaped: named nodes, monitors, and `call`/`cast`/`handle` over any
transport. Message passing replaces remote spawns (JS cannot ship closures), and the Failure
envelope keeps channel identity across every hop — a declared failure arrives declared, not as
a clone-gutted `Error`.

```ts
import * as Node from 'actorboy/node';

const worker = Node.start('worker@ws', Node.wsTransport('ws://localhost:4369'));
worker.handle('render', (payload) => renderPage(payload));

const client = Node.start('client@ws', Node.wsTransport('ws://localhost:4369'));
const html = await client.call('worker@ws', 'render', { path: '/' }, 5000);
```

Transports: `memoryHub()` (same realm), `fromPort(worker)` (worker threads, iframes,
`MessagePort`), `wsTransport(url)` (sockets, binary codec by default, redialing with
exponential backoff and re-running the hello handshake on reopen). The relay server lives at
`actorboy/node/hub` — the one entry point that needs `ws`, kept out of the main barrel so
everything else stays browser-safe and dependency-free.

### Addressing a service, not a node

`call` takes three kinds of destination, which is what lets an address outlive the machine
behind it:

| destination            | Elixir counterpart      | semantics                                  |
| ---------------------- | ----------------------- | ------------------------------------------ |
| `'worker@ws'`          | a node name             | that node, or a declared `NodeUnreachable`  |
| `'group:renderers'`    | `:pg` process groups    | round-robin across the group's members      |
| `'via:rooms/lobby'`    | `{:via, Registry, …}`   | the ONE node that owns that key             |

```ts
worker.join('renderers'); // membership gossips; a `bye` or a dropped socket prunes it
await client.call('group:renderers', 'render', { path: '/' }, 5000);

worker.register('rooms', 'lobby'); // one owner per key, smallest node name wins a conflict
await client.call('via:rooms/lobby', 'chat.post', { text: 'hi' }, 5000);
```

Registration is deliberately **optimistic** — a synchronous duplicate rejection is impossible
under gossip lag, so a losing node is told via `onConflict` and tears down what it was serving.
`rendezvous(key, nodes)` picks the same owner on every caller without any coordination at all
(HRW hashing: a join or a leave moves ~1/N of keys, not all of them).

Membership and the registry are backed by a **delta-state CRDT** (an ORSWOT with a dot-cloud
causal context), gossiped as deltas and reconciled by periodic anti-entropy. Convergence does
not depend on any frame arriving: the chaos suite drops 40% of them and the cluster still
agrees. `monitorNodes` reports both directions — `nodeup` as well as `nodedown` — so work that
follows membership (rebalancing a key range onto a joining host, warming a cache) can react to
scale-**up**, not only to loss.

### Hot code upgrades

Erlang's release mechanics on web standards: `import()` is the code server, run-to-completion
is suspend/resume, and `codeChange` is `code_change/3`.

```ts
const counter = Node.genServer(node, 'counter', behaviorV1);
await client.call('counter@ws', 'counter.sys.upgrade', { url: './counter-v2.ts' });
```

See [docs/hot-code-upgrades.md](docs/hot-code-upgrades.md).

### The unit — `genServer` and `Process`

`genServer(node, name, behavior)` is OTP's `gen_server`: a named, stateful unit with a real
mailbox (messages serialize per unit, async handlers included), links and `trapExit` for Erlang's
exit signals, an optional `Store` seam for persist-before-ack durability, `maxMailbox` load
shedding, an observer protocol for `:dbg`-style frame tracing, and `crashOnError` for OTP's
let-it-crash. Handlers receive a `self` context — `self.name`, `self.from`, `self.deadline`,
`self.trace`, and the self-operations `link` / `exit` / `send_after`.

`Process` is Erlang's `Process` module: `Process.spawn(node, behavior)` starts an **anonymous**
unit addressed by handle rather than by name (including `spawn` of a bare function),
`Process.link` / `exit` / `alive` / `whereis` / `list`, and `Process.of(node)` for a node-bound
namespace. `superviseGenServer` wraps a unit as a supervisable `Service`, which is what lets a
`distributedSupervisor` child be a gen_server that survives its host.

## PubSub, Presence, Telemetry

Three services that fall out of a converging cluster, each its own entry point.

```ts
import * as PubSub from 'actorboy/pubsub';
import * as Presence from 'actorboy/presence';
import * as Telemetry from 'actorboy/telemetry';

const bus = PubSub.pubsub(node); // Phoenix.PubSub, over the same process groups Phoenix uses pg for
bus.subscribe('rooms:lobby', (event, payload) => render(event, payload));
bus.broadcast('rooms:lobby', 'message', { text: 'hi' }); // reaches every subscriber, every node

const tracker = Presence.presence(node); // Phoenix.Presence — the same ORSWOT, so it converges too
tracker.track('rooms:lobby', 'user:1', { name: 'ada' });

Telemetry.attach('metrics', ['node', 'call'], (event, measurements) => record(event, measurements));
```

`reliablePubSub` adds at-least-once delivery (per-sender sequence, gap-triggered replay, dedup,
and a heartbeat so tail loss is detected) for topics where dropping a message is not acceptable.
`shardedPresence` is the partitioned counterpart — one rendezvous-chosen coordinator per topic,
so memory scales with the cluster rather than with every node holding everything.

Load protection has three legs, all in `actorboy/node`: `circuitBreaker` (Erlang's `:fuse` — fail
fast past a peer that is already failing), `rateLimiter` (token bucket, sustained rate plus
burst), and the served unit's `maxMailbox`. `cluster()` is libcluster's polling formation:
a strategy discovers peers, the manager diffs against the connected set and converges.

## Raft — the CP half

CRDTs stay available under partition by never needing agreement. Some decisions *do* need it:
a lock, a lease, a unique sequence. `actorboy/raft` is a replicated log where a command commits
only on a **majority** and applies in the same order everywhere, so a minority partition cannot
decide anything — Erlang `ra`'s role, with pre-vote, read-index reads, leadership transfer, log
compaction and membership change.

```ts
import * as Raft from 'actorboy/raft';

const group = Raft.raft(node, {
  peers: ['a@ws', 'b@ws', 'c@ws'],
  init: () => ({ balance: 0 }),
  apply: (command, state) => ({ state: applyCommand(state, command), reply: 'ok' }),
});

await group.submit({ deposit: 100 }); // resolves once a majority has the entry
```

Use a Raft group for the few things that must be linearizable and the AP layer for everything
that should stay available. `shardedRegistry` sits between them: each key lives on one
rendezvous-chosen coordinator, so memory scales with the cluster instead of every node holding
every key — and because claims serialize through that coordinator, it restores Elixir's
**synchronous** duplicate rejection, which the fully-replicated registry structurally cannot.

## Jobs, Sagas, Cache, Logger

```ts
import { Job, leader } from 'actorboy/job';
import { saga } from 'actorboy/saga';
```

`Job.queue` is Oban: jobs persist through the `Store` seam **before** `insert` resolves, run under
per-queue concurrency limits, retry with backoff to `maxAttempts` (then stay as `discarded`, with
their errors), and are rescued after a crash. Distributed by default — every node drains the same
store and the atomic `Store.claim` (`SKIP LOCKED`, in the Postgres case) partitions the work, so
there is no election to get wrong. Cron entries fire **cluster-once** via `leader()`, Oban's Peer,
which is a `Store.lease` rather than a consensus round.

`saga` is Sage: multi-entity transactions above single-key atomicity. Steps run forward threading a
context; on a failure the completed steps' compensations run **in reverse** — the distributed
substitute for two-phase commit. With a `Store` the step log is durable, so a saga stranded by a
crash rolls back through `recover()`. Compensations must be idempotent, and the docs say so.

`distributedCache` is an `LWWMap` gossiped over PubSub — cluster-coherent, no central Redis, reads
local and O(1). Eventually consistent **by design**: for a strongly consistent value, read the
owning actor through `via:`, not the cache.

Two `Store` backends ship in `actorboy/node`: `fileStore` (disk, with opt-in `fsync` durability and
an orphan sweep) for a single host with no database, and `postgresStore` — driver-**injected**, so
the library keeps its zero dependencies while the application brings `postgres`, `pg`, or anything
with a `query(text, params)`. `workerPool` puts CPU-bound handlers on real worker threads, each a
node in the cluster, which is what stops one expensive handler from freezing the event loop
everything else runs on.

`logger` takes `() => node.trace()` and every line then carries the ambient distributed-trace id,
which is what correlates logs with the request tree and the telemetry span without a single
call-site change.

## Documentation

- [docs/error-handling.md](docs/error-handling.md) — the full design argument: why the value is
  bare, why the discriminant is a string, the corner cases, the performance measurements, and
  an honest section on when _not_ to use any of this.
- [docs/hot-code-upgrades.md](docs/hot-code-upgrades.md) — the Erlang↔JS mapping.
- [docs/jobs-and-supervision.md](docs/jobs-and-supervision.md) — the durable queue, leadership by
  lease, and how a supervision tree, a `Store` and a worker pool compose into a running system.
- [examples/fault-tolerant-ledger](examples/fault-tolerant-ledger) — the fault-and-CPU
  boundary, architected: a supervised worker pool, worker-owned streaming, fail-fast
  readiness, and a demo that shows what one CPU-bound handler does to a single-threaded node.
- [examples/realtime-chat](examples/realtime-chat) — the stateful-entity pattern: durable rooms
  over a `DynamicSupervisor` + `Registry`, rendezvous routing, persist-before-ack.
- [examples/web-server.ts](examples/web-server.ts) — `node examples/web-server.ts`: a real
  HTTP server against live fs/network edges where the `try`/`catch` keyword appears in exactly
  one function body in the whole program. Deliberately self-contained — it reimplements a
  minimal Task/Failure rather than importing them, so the rules can be read in one file.

Every public symbol carries a fenced example, and CI type-checks _and runs_ all of them
(`deno check --doc` + `deno test --doc`) — an example that stops compiling is a failing build.

## Development

```sh
make check   # format + lint + doc gates + tests, on both runtimes
make test    # node --test
```

## License

MIT
