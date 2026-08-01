#!/usr/bin/env node
// The published entry point for the `actorboy` binary. It calls `main` explicitly rather than
// relying on cli.ts's self-execution guard: that guard compares `import.meta.filename` against
// `process.argv[1]`, which is THIS file when npm links the bin — so the guard is correctly false
// here and would leave the CLI doing nothing at all.
//
// It points at dist/, because that is what a consumer installs; the `.ts` source runs directly
// under node and deno in this repo only.
import { main } from '../dist/cli.js';

process.exitCode = await main(process.argv.slice(2));
