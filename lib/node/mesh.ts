/**
 * `meshTransport` — a {@link Transport} that talks **directly to peers** instead of through a
 * relay {@link memoryHub}. The shipped hub is a single relay: every inter-node frame transits it,
 * so it's a throughput bottleneck and a single point of failure. A mesh removes that — each node
 * holds one link per peer and routes a directed frame straight to its target, broadcasting only
 * true gossip. Because the `Node` core is transport-agnostic, this is a drop-in: `call`/`cast`/
 * `via` don't change, only what carries the frames.
 *
 * The routing is universal and injectable: you supply peer discovery (`peers`, e.g. from
 * {@link cluster}) and a `link` factory that opens one bidirectional {@link MeshLink} to a peer
 * (a WebSocket in production, an in-memory channel in tests). The transport maintains links as
 * peers come and go, sends a frame with a `to` on that peer's link, and broadcasts a frame without
 * one to every link.
 *
 * ```ts
 * import { start } from './node.ts';
 * const net = meshNetwork(['a@mesh', 'b@mesh']);
 * const a = start('a@mesh', meshTransport('a@mesh', net.for('a@mesh')));
 * const b = start('b@mesh', meshTransport('b@mesh', net.for('b@mesh')));
 * b.handle('add', (p) => (p as number[]).reduce((x, y) => x + y, 0));
 * await a.call('b@mesh', 'add', [2, 3]); // 5 — routed peer-to-peer, no hub
 * a.stop();
 * b.stop();
 * ```
 */
import type { Transport, Frame } from './node.ts';

/** One bidirectional link to a single peer — a WebSocket in prod, an in-memory channel in tests. */
export interface MeshLink {
  /** Send a frame to the peer at the other end. */
  send(frame: Frame): void;
  /** Register the inbound-frame handler for this link. */
  onFrame(handler: (frame: Frame) => void): void;
  /** Tear the link down. */
  close(): void;
}

/**
 * Build a mesh {@link Transport} for `self`. `peers()` reports who should be linked (poll it from
 * {@link cluster}); `link(peer)` opens one {@link MeshLink}. Directed frames route to one peer;
 * frames without a `to` broadcast to every link.
 *
 * ```ts
 * const net = meshNetwork();
 * const t = meshTransport('n@1', net.for('n@1'));
 * typeof t.send; // 'function'
 * t.close?.();
 * ```
 */
export function meshTransport(
  self: string,
  options: { peers: () => Iterable<string>; link: (peer: string) => MeshLink; pollMs?: number },
): Transport {
  const links = new Map<string, MeshLink>();
  let inbound: (frame: Frame) => void = () => {};
  let timer: ReturnType<typeof setInterval> | undefined;

  const sync = (): void => {
    const want = new Set(options.peers());
    want.delete(self);
    for (const peer of want) {
      if (links.has(peer)) continue;
      const link = options.link(peer);
      link.onFrame((frame) => inbound(frame)); // fan every link's inbound into the node
      links.set(peer, link);
    }
    for (const [peer, link] of [...links]) {
      if (!want.has(peer)) {
        link.close();
        links.delete(peer);
      }
    }
  };

  return {
    send(frame) {
      if (frame.to !== undefined) {
        const link = links.get(frame.to);
        if (link) link.send(frame);
        else for (const link of links.values()) link.send(frame); // pre-discovery fallback
      } else {
        for (const link of links.values()) link.send(frame); // gossip
      }
    },
    onFrame(handler) {
      inbound = handler;
      sync();
      timer = setInterval(sync, options.pollMs ?? 1000);
      (timer as { unref?: () => void }).unref?.();
    },
    close() {
      if (timer) clearInterval(timer);
      for (const link of links.values()) link.close();
      links.clear();
    },
  };
}

/**
 * An in-process mesh network for tests and doctests — models one bidirectional channel per pair of
 * nodes, so `meshTransport` can be exercised with real per-peer routing and no central relay.
 * `net.for(name)` yields the `{ peers, link }` options for that node.
 *
 * ```ts
 * const net = meshNetwork(['a@n', 'b@n']);
 * const opts = net.for('a@n');
 * [...opts.peers()]; // ['a@n', 'b@n']
 * ```
 */
export function meshNetwork(members: string[] = []): {
  for(self: string): { peers: () => Iterable<string>; link: (peer: string) => MeshLink };
} {
  const roster = new Set(members);
  // One channel per unordered pair; each side buffers until its peer wires a handler.
  const ends = new Map<string, { handler?: (f: Frame) => void; buffer: Frame[] }>();
  const endKey = (from: string, to: string) => `${from}\0${to}`;
  const endFor = (from: string, to: string) => {
    const k = endKey(from, to);
    let end = ends.get(k);
    if (!end) ends.set(k, (end = { buffer: [] }));
    return end;
  };

  return {
    for(self) {
      roster.add(self);
      return {
        peers: () => roster,
        link: (peer) => {
          roster.add(peer);
          const mine = endFor(self, peer); // where the peer delivers to me
          return {
            send(frame) {
              const theirs = endFor(peer, self); // where I deliver to the peer
              if (theirs.handler) theirs.handler(frame);
              else theirs.buffer.push(frame);
            },
            onFrame(handler) {
              mine.handler = handler;
              for (const frame of mine.buffer.splice(0)) handler(frame);
            },
            close() {
              mine.handler = undefined;
            },
          };
        },
      };
    },
  };
}
