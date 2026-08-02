import { module, test } from 'qunitx';
import { main, observe, runHub, UsageFailure } from '../../cli.ts';
import * as Node from '../../lib/node/index.ts';

// `main` writes through an injected sink rather than console.log, so every assertion here reads
// exactly what a user would see — no stdout capture, no subprocess, no flake.
const capture = async (argv: string[]): Promise<{ code: number; output: string }> => {
  const lines: string[] = [];
  const code = await main(argv, (line) => lines.push(line));
  return { code, output: lines.join('\n') };
};

module('CLI | argv boundary', () => {
  test('no arguments, --help and help all print usage and exit 0', async (assert) => {
    for (const argv of [[], ['--help'], ['-h'], ['help']]) {
      const { code, output } = await capture(argv);
      assert.strictEqual(code, 0, `\`${argv.join(' ') || '(none)'}\` exits 0`);
      assert.true(output.includes('actorboy hub'), 'usage names the hub command');
      assert.true(output.includes('actorboy observe'), 'and the observe command');
    }
  });

  test('--version prints the package version and nothing else', async (assert) => {
    const { code, output } = await capture(['--version']);
    assert.strictEqual(code, 0);
    assert.true(
      /^\d+\.\d+\.\d+/.test(output),
      `a bare semver, so \`$(actorboy --version)\` is usable — got ${output}`,
    );
  });

  test('an unknown command is a declared UsageFailure — one line, exit 2, no stack', async (assert) => {
    const { code, output } = await capture(['frobnicate']);
    assert.strictEqual(code, 2, '2, not 1: a misuse is not a failed health check');
    assert.true(output.includes('unknown command `frobnicate`'), 'it names what was wrong');
    assert.false(output.includes('    at '), 'and carries no stack — this is not a bug');
  });

  test('observe without a URL, and hub with a non-integer port, are both usage errors', async (assert) => {
    const missingUrl = await capture(['observe']);
    assert.strictEqual(missingUrl.code, 2);
    assert.true(missingUrl.output.includes('needs a hub URL'));

    const badPort = await capture(['hub', '--port', 'abc']);
    assert.strictEqual(badPort.code, 2);
    assert.true(badPort.output.includes('--port must be an integer'));
  });

  test('UsageFailure is a real Failure — discriminable, with its detail as the message', (assert) => {
    const failure = UsageFailure({ detail: 'no cookie' });
    assert.true(UsageFailure.is(failure), 'the factory guard narrows it');
    assert.strictEqual(failure.message, 'no cookie');
    assert.strictEqual(failure.code, 'UsageFailure');
  });
});

module('CLI | hub and observe against a live cluster', () => {
  test('the hub relays a real cluster, and observe reports every peer as a hidden node', async (assert) => {
    const hub = await runHub({ port: 0 }); // 0 — let the OS pick, so parallel runs cannot collide
    const url = `ws://localhost:${hub.port}`;
    const alpha = Node.start('alpha@cli', Node.wsTransport(url));
    const beta = Node.start('beta@cli', Node.wsTransport(url));
    alpha.join('renderers');
    beta.register('rooms', 'lobby');
    await alpha.synced();
    await beta.synced();

    const report = await observe(url, { name: 'watcher@cli', timeoutMs: 2000 });

    assert.strictEqual(report.observer, 'watcher@cli');
    const names = report.peers.map((peer) => peer.node).sort();
    assert.deepEqual(names, ['alpha@cli', 'beta@cli'], 'both peers answered');
    assert.true(
      report.peers.every((peer) => peer.info !== null),
      'every sys.node.info call came back',
    );
    const alphaReport = report.peers.find((peer) => peer.node === 'alpha@cli')!;
    assert.deepEqual(
      (alphaReport.info!.groups as Record<string, string[]>).renderers,
      ['alpha@cli'],
      'the observer sees the process group alpha joined, and who is in it',
    );

    // The point of --hidden: the observer read everything and joined nothing. Neither peer's
    // default `list()` contains it, so it is out of rendezvous placement and `:global` too.
    assert.false(alpha.list().includes('watcher@cli'), 'alpha does not count the observer');
    assert.false(beta.list().includes('watcher@cli'), 'nor does beta');

    alpha.stop();
    beta.stop();
    await hub.close();
  });

  test('observe of an empty cluster is a clean, zero-peer report — not an error', async (assert) => {
    const hub = await runHub({ port: 0 });
    const report = await observe(`ws://localhost:${hub.port}`, { timeoutMs: 500 });
    assert.deepEqual(report.peers, [], 'no peers, no failures');
    assert.true(
      /^observer-\d+@cli$/.test(report.observer),
      `the default name carries the pid — got ${report.observer}`,
    );
    await hub.close();
  });

  test('--cert without --key is rejected before anything binds', async (assert) => {
    const { code, output } = await capture(['hub', '--cert', 'server.pem']);
    assert.strictEqual(code, 2);
    assert.true(output.includes('--cert and --key must be given together'));
  });
});
