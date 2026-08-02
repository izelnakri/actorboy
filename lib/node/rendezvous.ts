/**
 * Rendezvous (Highest-Random-Weight) hashing — pick THE node responsible for a key, such that
 * adding or removing a node reshuffles only ~1/N of keys (the ones that scored highest for the
 * changed node), not all of them. That minimal-movement property is the difference between a
 * cluster that can scale without a storm of key migrations and one that can't.
 *
 * Why not `hash(key) % nodes.length`? Modulo remaps almost every key the instant N changes —
 * one node joining or leaving relocates the whole keyspace. Rendezvous relocates a fair 1/N.
 * (A consistent-hash ring achieves the same with virtual nodes; HRW is simpler and needs none,
 * which suits the small clusters this system targets.)
 *
 * The chosen owner is deterministic and agreed by every node that sees the same node set — so
 * pairing it with a registry (publish the winner) makes cold-start races impossible: everyone
 * routes "create X" to the same node.
 *
 * ```ts
 * const owner = rendezvous('room:lobby', ['a@n', 'b@n', 'c@n']);
 * typeof owner; // 'string' — the same node for this key on every caller
 * rendezvous('anything', []); // null — no nodes
 * ```
 */
export function rendezvous(key: string, nodes: readonly string[]): string | null {
  let best: string | null = null;
  let bestScore = -1;
  for (const node of nodes) {
    // NUL as the separator, written as an escape rather than a literal byte: it cannot occur
    // in a key or a node name, so `("a", "b/c")` and `("a/b", "c")` can never hash alike — and
    // a source file with a raw control character in it is one that git calls binary and grep
    // refuses to search.
    const score = weigh(`${key}\0${node}`);
    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  }
  return best;
}

// A fast, well-mixed 32-bit hash: FNV-1a followed by murmur3's fmix32 avalanche — the
// finalizer matters, since short node suffixes otherwise mix poorly and skew ownership.
// Deterministic across runtimes, no crypto needed.
function weigh(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
