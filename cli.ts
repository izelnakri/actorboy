#!/usr/bin/env node
/**
 * The `actorboy` CLI — two operational commands the library cannot provide as an import.
 *
 * This package is a JS API first, and almost everything in it is something you call from your own
 * process. Two things are not:
 *
 *   hub      the relay is a SERVER. Somebody has to run it, and "write four lines of glue and
 *            `node hub.js` it" is a worse answer than shipping the binary that does it.
 *   observe  Erlang's `:observer`, reduced to data. It attaches to a running cluster as a HIDDEN
 *            node — so it can read `sys.node.info` from every peer without joining rendezvous
 *            placement, `:global`, or anyone's `list()`. That is precisely the case `-hidden`
 *            exists for, and it only works from a separate process.
 *
 * Both stand on `ws`, which is an OPTIONAL peer dependency — the library's other entry points
 * install with nothing. The CLI is the one place that dependency is not optional, so it says so
 * with a real error rather than a module-resolution stack trace.
 */
import { parseArgs } from 'node:util';
import * as Node from './lib/node/index.ts';
import { Task } from './lib/task/index.ts';
import * as Failure from './lib/result/failure.ts';

/** A CLI invocation that cannot proceed — a bad flag, a missing argument, an absent peer dep. */
export const UsageFailure: Failure.FailureFactory<'UsageFailure', { detail: string }> =
  Failure.define('UsageFailure', (data: { detail: string }) => data.detail);

const HELP = `actorboy — Elixir/OTP's runtime model on web standards

Usage:
  actorboy hub [options]              Run the relay hub (epmd + the mesh, in one server)
  actorboy observe <url> [options]    Attach to a cluster as a hidden node and dump its state
  actorboy --version
  actorboy --help

hub options:
  --port <n>       Port to bind (default 4369 — epmd's, for the culture). 0 asks the OS.
  --cookie <s>     Shared cluster secret. Every socket is challenged and must prove
                   HMAC-SHA-256(secret, nonce) before a single frame is relayed.
                   Without it the hub is open to anyone who can reach the port.
  --cert <path>    TLS certificate (PEM) — serve wss:// instead of ws://.
  --key <path>     TLS private key (PEM). Required with --cert.

observe options:
  --name <s>       This observer's node name (default: observer-<pid>@cli).
  --cookie <s>     Cluster secret, if the hub requires one.
  --timeout <ms>   Per-peer deadline for sys.node.info (default 5000).
  --json           Emit one JSON object instead of the human-readable report.

Examples:
  actorboy hub --port 4369 --cookie "$ACTORBOY_COOKIE"
  actorboy observe ws://localhost:4369 --json | jq '.peers[].units'
`;

/** What a single peer reported through the `sys.node.info` observer subject. */
export interface PeerReport {
  /** The peer's node name. */
  node: string;
  /** Its view of the cluster and its units, or `null` when it did not answer in time. */
  info: Record<string, unknown> | null;
  /** Why it did not answer, when `info` is null. */
  error?: string;
}

/**
 * Runs the relay hub until the process is signalled. Resolves with the bound port and a `close`,
 * so a test can drive it without a subprocess.
 *
 * ```ts
 * // Defined, not invoked: binds a real port and loads `ws`.
 * async function boot() {
 *   return runHub({ port: 0 });
 * }
 * ```
 */
export async function runHub(options: {
  port?: number;
  cookie?: string;
  cert?: string;
  key?: string;
}): Promise<{ port: number; close: () => Promise<void> }> {
  // Imported lazily and by specifier so the message below is what a user without `ws` sees,
  // rather than an unresolved-module stack trace from the top of the file.
  const { startHub } = await import('./lib/node/hub.ts').catch(() => {
    throw UsageFailure({
      detail:
        'the hub needs the optional peer dependency `ws` — install it with `npm install ws`.\n' +
        'Every other entry point of this package installs with no dependencies at all.',
    });
  });

  if ((options.cert === undefined) !== (options.key === undefined)) {
    throw UsageFailure({ detail: '--cert and --key must be given together' });
  }
  const tls = options.cert ? await readTls(options.cert, options.key as string) : undefined;

  const hub = startHub({ port: options.port ?? 4369, secret: options.cookie, tls });
  return { port: hub.port(), close: hub.close };
}

/**
 * Attaches to `url` as a HIDDEN node, asks every peer for `sys.node.info`, and reports what came
 * back. Hidden is the whole point: the observer reads the cluster without becoming part of it.
 *
 * ```ts
 * // Defined, not invoked: dials a real socket.
 * async function look() {
 *   return observe('ws://localhost:4369', { timeoutMs: 250 });
 * }
 * ```
 */
export async function observe(
  url: string,
  options: { name?: string; cookie?: string; timeoutMs?: number } = {},
): Promise<{ observer: string; peers: PeerReport[] }> {
  const name = options.name ?? `observer-${process.pid}@cli`;
  const timeoutMs = options.timeoutMs ?? 5000;
  const node = Node.start(name, Node.wsTransport(url, { secret: options.cookie }), {
    hidden: true, // Erlang's -hidden: read the cluster, stay out of its topology
  });
  try {
    await node.synced(); // the CRDT context has landed — `list()` is meaningful now
    // 'known' rather than the default 'visible': an observer wants to see the OTHER observers and
    // tooling nodes attached to this cluster too, which is exactly what hidden peers are.
    const peers = node.list('known').filter((peer) => peer !== name);
    const reports = await Task.all(
      peers.map((peer) =>
        node
          .call<Record<string, unknown>>(peer, 'sys.node.info', undefined, timeoutMs)
          .map((info): PeerReport => ({ node: peer, info }))
          .recover((error) => ({ node: peer, info: null, error: Failure.format(error) })),
      ),
    );
    return { observer: name, peers: reports };
  } finally {
    node.stop();
  }
}

async function readTls(cert: string, key: string): Promise<{ cert: string; key: string }> {
  const { readFile } = await import('node:fs/promises');
  const [certPem, keyPem] = await Task.all([
    Task(() => readFile(cert, 'utf8')),
    Task(() => readFile(key, 'utf8')),
  ]).mapErr((cause) =>
    UsageFailure({ detail: `could not read the TLS materials: ${Failure.format(cause)}` }),
  );
  return { cert: certPem, key: keyPem };
}

function renderReport(result: { observer: string; peers: PeerReport[] }): string {
  const lines = [`${result.observer} (hidden) sees ${result.peers.length} peer(s)`];
  for (const peer of result.peers) {
    if (!peer.info) {
      lines.push(`  ${peer.node}  — no answer: ${peer.error ?? 'unknown'}`);
      continue;
    }
    const units = (peer.info.units as { name: string }[] | undefined) ?? [];
    // `groups` is group -> live members, so render it as pairs rather than flattening away the
    // half a reader actually wants (who is in each one).
    const groups = Object.entries((peer.info.groups as Record<string, string[]>) ?? {});
    lines.push(`  ${peer.node}`);
    lines.push(`    peers      ${((peer.info.peers as string[]) ?? []).join(', ') || '—'}`);
    lines.push(
      `    groups     ${groups.map(([g, members]) => `${g}(${members.length})`).join(', ') || '—'}`,
    );
    lines.push(`    registered ${String(peer.info.registered ?? 0)}`);
    lines.push(`    units      ${units.map((unit) => unit.name).join(', ') || '—'}`);
  }
  return lines.join('\n');
}

/**
 * The argv → outcome boundary, exported so the suite can drive every command without spawning.
 * Returns the exit code; everything it prints goes through `write`.
 *
 * ```ts
 * const printed: string[] = [];
 * await main(['--version'], (line) => printed.push(line)); // 0
 * printed.length; // 1 — the version, nothing else
 * ```
 */
export async function main(
  argv: string[],
  write: (line: string) => void = (line) => console.log(line),
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    write(HELP);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    const { default: pkg } = await import('./package.json', { with: { type: 'json' } });
    write((pkg as { version: string }).version);
    return 0;
  }

  try {
    if (command === 'hub') {
      const { values } = parseArgs({
        args: rest,
        options: {
          port: { type: 'string' },
          cookie: { type: 'string' },
          cert: { type: 'string' },
          key: { type: 'string' },
        },
      });
      const port = values.port === undefined ? undefined : Number(values.port);
      if (port !== undefined && !Number.isInteger(port)) {
        throw UsageFailure({ detail: `--port must be an integer, got ${values.port}` });
      }
      const hub = await runHub({ port, cookie: values.cookie, cert: values.cert, key: values.key });
      write(
        `actorboy hub listening on ${values.cert ? 'wss' : 'ws'}://0.0.0.0:${hub.port}` +
          (values.cookie ? ' (cookie required)' : ' (open — no cookie set)'),
      );
      // The hub is a server: hold the process until it is signalled, then close politely so every
      // connected node gets its `bye` instead of a socket that simply stops answering.
      await new Promise<void>((resolve) => {
        for (const signal of ['SIGINT', 'SIGTERM'] as const) {
          process.once(signal, () => resolve());
        }
      });
      await hub.close();
      write('actorboy hub stopped');
      return 0;
    }

    if (command === 'observe') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          name: { type: 'string' },
          cookie: { type: 'string' },
          timeout: { type: 'string' },
          json: { type: 'boolean' },
        },
      });
      const [url] = positionals;
      if (!url) throw UsageFailure({ detail: 'observe needs a hub URL, e.g. ws://localhost:4369' });
      const result = await observe(url, {
        name: values.name,
        cookie: values.cookie,
        timeoutMs: values.timeout === undefined ? undefined : Number(values.timeout),
      });
      write(values.json ? JSON.stringify(result) : renderReport(result));
      // A peer that did not answer is a real finding, not a formatting detail — say so in the
      // exit code, so a health check can be `actorboy observe … >/dev/null`.
      return result.peers.some((peer) => peer.info === null) ? 1 : 0;
    }

    throw UsageFailure({ detail: `unknown command \`${command}\` — try \`actorboy --help\`` });
  } catch (error) {
    // A UsageFailure is a declared outcome: report it as one line, no stack. Anything else is a
    // bug and keeps its stack, because that is the difference this whole library is built on.
    if (UsageFailure.is(error)) {
      write(`actorboy: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

// Only when executed, never when imported by the suite.
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
