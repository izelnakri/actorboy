// Root barrel — the whole system in one import, namespaced Noun.verb:
//
//   import { Result, Task, Stream, Supervisor, Node, Failure } from 'actorboy';
//
// Every namespace here is also its own entry point, which is the spelling to prefer when you
// only need one leg (`actorboy/task` pulls in Result + Failure and nothing else):
//
//   import * as Result from 'actorboy/result';
//   import { Task } from 'actorboy/task';
//   import { Stream } from 'actorboy/stream';
//   import * as Supervisor from 'actorboy/supervisor';
//   import * as Node from 'actorboy/node';
//   import { startHub } from 'actorboy/node/hub';   // the one entry that needs `ws`
//
// The four legs are one system with one failure vocabulary: `Result` is a settled outcome,
// `Task` a future outcome, `Stream` many outcomes over time, `Supervisor` what keeps the
// producers alive — and `Node` is the same vocabulary crossing a wire, failures included.
// `Failure` is that vocabulary: a declared, discriminable, serialisable error kind.

/**
 * Settled outcomes — the bare `T | E` union, its boundary verbs, and the failure taxonomy.
 *
 * ```ts
 * import { Result } from './mod.ts';
 * Result.try(JSON.parse, '{"port":8080}'); // { ok: true, value: { port: 8080 } }
 * ```
 */
export * as Result from './lib/result/index.ts';

/**
 * The failure taxonomy — declared, discriminable, serialisable error kinds. The single error
 * currency of every leg: a Result's `E`, a Task's rejection, a Stream's error element.
 *
 * ```ts
 * import { Failure } from './mod.ts';
 * const NotFound = Failure.define('NotFound', (d: { id: number }) => `no user ${d.id}`);
 * NotFound.is(NotFound({ id: 7 })); // true
 * ```
 */
export * as Failure from './lib/result/failure.ts';

/**
 * Future outcomes — a lazy, retryable Promise superset whose declared failures are Failures.
 *
 * ```ts
 * import { Task } from './mod.ts';
 * await Task(() => 21).map((n) => n * 2); // 42
 * ```
 */
export { Task } from './lib/task/task.ts';

/**
 * Many outcomes over time — a lazy async pipeline whose elements are the same bare union.
 *
 * ```ts
 * import { Stream } from './mod.ts';
 * await Stream.from([1, 2, 3]).map((n) => n * 2).values(); // [2, 4, 6]
 * ```
 */
export { Stream, type Source } from './lib/stream/stream.ts';

/**
 * OTP supervision for in-process JS — restart policies, strategies, and an intensity budget.
 *
 * ```ts
 * import { Supervisor } from './mod.ts';
 * const tree = Supervisor.start([{ id: 'worker', restart: 'temporary', start: () => 'ran' }]);
 * await tree.stop();
 * ```
 */
export * as Supervisor from './lib/supervisor/index.ts';

/**
 * Elixir's `Node` — named nodes, monitors, and `call`/`cast`/`handle` over any transport,
 * with the Failure envelope keeping declared failures declared across the wire.
 *
 * ```ts
 * import { Node } from './mod.ts';
 * const hub = Node.memoryHub();
 * const a = Node.start('a@memory', hub.transport());
 * a.stop();
 * ```
 */
export * as Node from './lib/node/index.ts';

/**
 * Phoenix.PubSub — cluster-wide topic pub/sub over the CRDT-backed process groups, exactly as
 * Phoenix builds its own on `pg`. `reliablePubSub` is the at-least-once variant.
 *
 * ```ts
 * import { Node, PubSub } from './mod.ts';
 * const hub = Node.memoryHub();
 * const node = Node.start('a@memory', hub.transport());
 * const bus = PubSub.pubsub(node);
 * bus.subscribe('rooms:lobby', (event, payload) => [event, payload]);
 * bus.broadcast('rooms:lobby', 'message', 'hello');
 * node.stop();
 * ```
 */
export * as PubSub from './lib/pubsub/index.ts';

/**
 * Phoenix.Presence — who is present on a topic, across the cluster, converging without
 * coordination because it is the same ORSWOT the membership layer already runs under frame loss.
 *
 * ```ts
 * import { Node, Presence } from './mod.ts';
 * const hub = Node.memoryHub();
 * const node = Node.start('a@memory', hub.transport());
 * const tracker = Presence.presence(node);
 * tracker.track('rooms:lobby', 'user:1', { name: 'ada' });
 * node.stop();
 * ```
 */
export * as Presence from './lib/presence/index.ts';

/**
 * Elixir's `:telemetry` — the instrumentation bus. Emitters `execute` named events; sinks
 * `attach` handlers. The two never know about each other, which is the whole point.
 *
 * ```ts
 * import { Telemetry } from './mod.ts';
 * Telemetry.attach('log', ['app', 'request'], (_event, measurements) => measurements);
 * Telemetry.execute(['app', 'request'], { durationMs: 12 });
 * Telemetry.detach('log');
 * ```
 */
export * as Telemetry from './lib/telemetry/index.ts';
