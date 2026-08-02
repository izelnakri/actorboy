// A pool module that cannot be imported. Used to prove that a thread which never gets as far as
// joining the group is contained by the pool: the host survives, the slot stops being re-armed,
// and `ready()` says so. The throw is at module scope so the failure is deterministic — the
// bootstrap's `await import()` rejects before any group registration can race it.
throw new Error('broken-worker.ts cannot be imported');

export function worker(): void {}
