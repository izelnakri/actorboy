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
`MessagePort`), `wsTransport(url)` (sockets, binary codec by default). The relay server lives
at `actorboy/node/hub` — the one entry point that needs `ws`, kept out of the main barrel
so everything else stays browser-safe and dependency-free.

### Hot code upgrades

Erlang's release mechanics on web standards: `import()` is the code server, run-to-completion
is suspend/resume, and `codeChange` is `code_change/3`.

```ts
const served = Node.serve(node, 'counter', behaviorV1);
await client.call('counter@ws', 'counter.sys.upgrade', { url: './counter-v2.ts' });
```

See [docs/hot-code-upgrades.md](docs/hot-code-upgrades.md).

## Documentation

- [docs/error-handling.md](docs/error-handling.md) — the full design argument: why the value is
  bare, why the discriminant is a string, the corner cases, the performance measurements, and
  an honest section on when _not_ to use any of this.
- [docs/hot-code-upgrades.md](docs/hot-code-upgrades.md) — the Erlang↔JS mapping.
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
