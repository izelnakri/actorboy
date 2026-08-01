/**
 * Benchmarks the many-outcomes-over-time layer.
 *
 * A Stream is a lazy pipeline over an async iterable, so every element pays one async
 * generator step per stage. That is the cost being measured, and the eager array equivalent
 * is benched beside it as the honest lower bound: a Stream is not free, it is bounded — you
 * reach for it when the data does not fit in memory or when the source is genuinely a flow,
 * and these numbers say what that choice costs when it does fit.
 *
 * `partition` is here because it is the shape the failure vocabulary makes cheap: elements
 * are the bare `T | E` union, so splitting values from failures is one pass with no
 * try/catch and no rejected-promise bookkeeping.
 */
import { Stream } from '../lib/stream/index.ts';
import * as Failure from '../lib/result/failure.ts';

const BadRow = Failure.define('BadRow', (data: { index: number }) => `row ${data.index}`);

const THOUSAND = Array.from({ length: 1000 }, (_, index) => index);
// One in ten elements is a declared failure — a realistic parse-a-batch shape rather than an
// all-happy pipeline that never exercises the error leg.
const MIXED = THOUSAND.map((n) => (n % 10 === 0 ? BadRow({ index: n }) : n));

const double = (n: number) => n * 2;
const isEven = (n: number) => n % 2 === 0;

Deno.bench('stream: map+filter over 1000, collected', { group: 'pipeline' }, async () => {
  await Stream.from(THOUSAND).map(double).filter(isEven).values();
});

Deno.bench('stream: the eager array equivalent', { group: 'pipeline' }, () => {
  THOUSAND.map(double).filter(isEven);
});

Deno.bench('stream: four-stage pipeline over 1000', { group: 'pipeline' }, async () => {
  await Stream.from(THOUSAND).map(double).filter(isEven).map(double).take(100).values();
});

// Laziness is the reason `take` belongs above: the source is 1000 elements, the consumer
// wants 10, and only 10 should ever be produced. If this ever approaches the full-pipeline
// number, laziness has regressed into eager evaluation.
Deno.bench('stream: take(10) of a 1000-element source', { group: 'lazy' }, async () => {
  await Stream.from(THOUSAND).map(double).take(10).values();
});

Deno.bench('stream: unfold + take(10) (infinite source)', { group: 'lazy' }, async () => {
  await Stream.unfold(0, (n) => [n, n + 1] as const)
    .take(10)
    .values();
});

Deno.bench('stream: partition 1000 mixed outcomes', { group: 'failures' }, async () => {
  await Stream.from(MIXED).partition();
});

Deno.bench('stream: chunkEvery(50) over 1000', { group: 'reshape' }, async () => {
  await Stream.from(THOUSAND).chunkEvery(50).values();
});

Deno.bench('stream: scan over 1000', { group: 'reshape' }, async () => {
  await Stream.from(THOUSAND)
    .scan((total, n) => total + n)
    .values();
});
