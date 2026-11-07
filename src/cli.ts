#!/usr/bin/env node
// Tiny entry point: check the Node version before loading anything that needs a newer one.
// Keep this file to syntax that old Node versions can parse (no top-level await, no `?.` or
// `??`), so they reach the version message instead of a SyntaxError.
const parts = process.versions.node.split('.').map(Number);
const major = parts[0] || 0;
const minor = parts[1] || 0;
if (major < 22 || (major === 22 && minor < 12)) {
  process.stderr.write(
    `setupscore needs Node.js 22.12 or newer. You have ${process.versions.node}.\nUpdate from https://nodejs.org and try again.\n`,
  );
  process.exit(2);
} else {
  start();
}

function start(): void {
  // If whoever reads our output goes away (piping into `head`) or the output cannot be written
  // (a full disk), stop writing it but finish the work: a run must still save its results.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', () => {
      stream.write = () => true;
    });
  }

  // FORCE_COLOR=0 (or false) means "no colours", but the colour library treats any FORCE_COLOR as "on".
  const force = process.env['FORCE_COLOR'];
  if (force === '0' || force === 'false') {
    delete process.env['FORCE_COLOR'];
    process.env['NO_COLOR'] = '1';
  }

  import('./core/lifecycle.js')
    .then((lifecycle) => {
      lifecycle.installSignalHandlers();
      return import('./main.js');
    })
    .then((m) => m.main(process.argv.slice(2)))
    .then((code) => {
      process.exitCode = code;
      // Exit once the output is written. Left to wind down by itself, Node puts back the default
      // Ctrl+C action while it closes, so a second Ctrl+C right then killed us instead of exit 4.
      process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
    })
    .catch((err: unknown) => {
      process.stderr.write(`setupscore could not start: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 2;
    });
}

export {};
