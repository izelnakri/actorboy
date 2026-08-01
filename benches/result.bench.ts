/**
 * Benchmarks the settled-outcome layer: the happy path, the boundary, and Failure
 * construction.
 *
 * The load-bearing claim of the bare-union Result is that a success costs NOTHING —
 * `Result<T, E> = T | E`, so the value IS the result and there is no box to allocate.
 * The first group exists to keep that claim honest: `return value` and
 * `Result.try(fn)`-on-a-success must stay within noise of each other. If a wrapper ever
 * creeps back into the success path, this is where it shows up.
 *
 * Failure construction is the other half. A Failure captures a stack by default (that is
 * the point — a declared failure you cannot locate is a worse error message), and
 * `stackless: true` is the opt-out for hot paths. The gap between the two is real and is
 * measured here so a regression in the capture path cannot hide.
 */
import * as Result from '../lib/result/index.ts';
import * as Failure from '../lib/result/failure.ts';

const NotFound = Failure.define('NotFound', (data: { id: number }) => `no user ${data.id}`);

// A depth-10 call stack, so stack capture measures something representative rather than the
// two frames a top-level bench body would produce.
function atDepth<T>(depth: number, fn: () => T): T {
  return depth === 0 ? fn() : atDepth(depth - 1, fn);
}

const JSON_SOURCE = '{"port":8080,"host":"localhost"}';
const FAILURE = NotFound({ id: 7 });
const SERIALIZED = Failure.toJSON(FAILURE);

// ── The happy path: three spellings of "it worked" ────────────────────────────

Deno.bench('result: return the value directly (baseline)', { group: 'happy-path' }, () => {
  atDepth(10, () => JSON.parse(JSON_SOURCE));
});

Deno.bench('result: try/catch around a success', { group: 'happy-path' }, () => {
  atDepth(10, () => {
    try {
      return JSON.parse(JSON_SOURCE);
    } catch (error) {
      return error;
    }
  });
});

Deno.bench('result: Result.try on a success', { group: 'happy-path' }, () => {
  atDepth(10, () => Result.try(JSON.parse, JSON_SOURCE));
});

// ── The boundary, when it actually catches ────────────────────────────────────

Deno.bench('result: Result.try on a throw', { group: 'boundary' }, () => {
  atDepth(10, () => Result.try(JSON.parse, '{not json'));
});

Deno.bench('result: rescue classifies a throw into a Failure', { group: 'boundary' }, () => {
  atDepth(10, () =>
    Result.rescue(
      () => JSON.parse('{not json'),
      () => NotFound({ id: 1 }),
    ),
  );
});

// ── Failure construction ──────────────────────────────────────────────────────

Deno.bench('failure: construct (stack anchored at the factory)', { group: 'construct' }, () => {
  atDepth(10, () => NotFound({ id: 7 }));
});

Deno.bench('failure: construct stackless', { group: 'construct' }, () => {
  atDepth(10, () => NotFound({ id: 7 }, { stackless: true }));
});

Deno.bench('failure: new Error for comparison', { group: 'construct' }, () => {
  atDepth(10, () => new Error('no user 7'));
});

// ── Discrimination and transport ──────────────────────────────────────────────

Deno.bench('failure: Failure.is on a failure', { group: 'discriminate' }, () => {
  Failure.is(FAILURE);
});

Deno.bench('failure: Failure.is on a plain value', { group: 'discriminate' }, () => {
  Failure.is({ port: 8080 });
});

Deno.bench('failure: factory guard (NotFound.is)', { group: 'discriminate' }, () => {
  NotFound.is(FAILURE);
});

Deno.bench('failure: toJSON (crossing a wire)', { group: 'transport' }, () => {
  Failure.toJSON(FAILURE);
});

Deno.bench('failure: fromJSON (arriving declared)', { group: 'transport' }, () => {
  Failure.fromJSON(SERIALIZED);
});
