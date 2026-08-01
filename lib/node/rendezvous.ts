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
 * Pass `weightOf` for **weighted** rendezvous — a node's expected share of the keyspace scales
 * with its weight, so heavier nodes hold proportionally more keys (heterogeneous capacity) and a
 * caller can bias placement toward its own **zone** for locality (boost same-zone nodes) — all
 * while keeping HRW's minimal-movement guarantee. The math is the standard weighted-HRW score
 * `weight × −1/ln(u)`, `u ∈ (0,1)` from the hash; a weight ≤ 0 opts a node out.
 *
 * ```ts
 * const owner = rendezvous('room:lobby', ['a@n', 'b@n', 'c@n']);
 * typeof owner; // 'string' — the same node for this key on every caller
 * rendezvous('anything', []); // null — no nodes
 *
 * // Zone-aware: nodes in 'eu' are twice as likely to own a key as 'us' ones.
 * const zone: Record<string, number> = { 'a@eu': 2, 'b@eu': 2, 'c@us': 1 };
 * const placed = rendezvous('cart:9', Object.keys(zone), (n) => zone[n]);
 * typeof placed; // 'string'
 * ```
 */
export function rendezvous(
  key: string,
  nodes: readonly string[],
  weightOf?: (node: string) => number,
): string | null {
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const node of nodes) {
    const hashed = weigh(
      // NUL as the separator, written as an escape rather than a literal byte: it cannot
      // occur in a key or a node name, so `("a", "b/c")` and `("a/b", "c")` can never hash
      // alike — and a source file with a raw control character in it is one that git calls
      // binary and grep refuses to search.
      `${key}\0${node}`,
    );
    let score: number;
    if (weightOf) {
      const weight = weightOf(node);
      if (weight <= 0) continue; // weight <= 0 opts the node out of ownership
      // u in (0,1); the standard weighted-HRW score. Equal weights fall back to raw hash order.
      const u = (hashed + 1) / 4294967297; // (hash+1)/(2^32+1) keeps u strictly inside (0,1)
      score = weight * (-1 / Math.log(u));
    } else {
      score = hashed;
    }
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
