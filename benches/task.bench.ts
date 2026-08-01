/**
 * Benchmarks the future-outcome layer.
 *
 * A Task is a real Promise (`instanceof Promise` holds, the Promises/A+ suite passes) built
 * from a lazy recipe. That buys laziness, lineage and retry — and the cost of those has to
 * stay small enough that reaching for a Task instead of a Promise is never a performance
 * decision. Every group below pairs the Task spelling with its native equivalent so the
 * overhead is legible rather than asserted.
 *
 * The `create` group also pins the thing laziness is FOR: constructing a Task that is never
 * awaited must not run its recipe, so it should be far cheaper than the eager Promise it
 * replaces.
 */
import { Task } from '../lib/task/index.ts';
import * as Failure from '../lib/result/failure.ts';

const NotFound = Failure.define('NotFound', (data: { id: number }) => `no user ${data.id}`);
const double = (n: number) => n * 2;

// ── Construction: what a Task costs before anyone awaits it ───────────────────

Deno.bench('task: construct (recipe never run)', { group: 'create' }, () => {
  Task(() => 21);
});

Deno.bench('task: Promise.resolve for comparison', { group: 'create' }, () => {
  Promise.resolve(21);
});

Deno.bench('task: construct + three derivations, unawaited', { group: 'create' }, () => {
  Task(() => 21)
    .map(double)
    .map(double)
    .map(double);
});

// ── Awaiting: the run, once ───────────────────────────────────────────────────

Deno.bench('task: await a one-step task', { group: 'await' }, async () => {
  await Task(() => 21).map(double);
});

Deno.bench('task: await the native equivalent', { group: 'await' }, async () => {
  await Promise.resolve(21).then(double);
});

Deno.bench('task: await a three-step chain', { group: 'await' }, async () => {
  await Task(() => 21)
    .map(double)
    .map(double)
    .map(double);
});

Deno.bench('task: memoised second await (shares one run)', { group: 'await' }, async () => {
  const task = Task(() => 21).map(double);
  await task;
  await task;
});

// ── The failure path: declared failures settle, they do not throw ─────────────

Deno.bench('task: result() on a declared failure', { group: 'failure' }, async () => {
  await Task(() => NotFound({ id: 7 })).result();
});

Deno.bench('task: mapErr classifies a foreign error', { group: 'failure' }, async () => {
  await Task(() => {
    throw new Error('boom');
  })
    .mapErr(() => NotFound({ id: 7 }))
    .result();
});

// ── Combinators: the overridden statics, and their laziness ───────────────────

const TEN = Array.from({ length: 10 }, (_, index) => index);

Deno.bench('task: Task.all over 10 members', { group: 'combinators' }, async () => {
  await Task.all(TEN.map((n) => Task(() => n)));
});

Deno.bench('task: Promise.all over 10 members', { group: 'combinators' }, async () => {
  await Promise.all(TEN.map((n) => Promise.resolve(n)));
});

Deno.bench('task: Task.results keeps every outcome bare', { group: 'combinators' }, async () => {
  await Task.results(TEN.map((n) => Task(() => (n % 3 === 0 ? NotFound({ id: n }) : n))));
});
