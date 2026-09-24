#!/usr/bin/env node
/**
 * Launch the mock IRC server for manual testing.
 *
 * The server is configured entirely through environment variables, and setting
 * those inline is spelled differently in every shell (`set X=1 &&` versus
 * `X=1`). A launcher makes the runbook one command everywhere, and keeps the
 * scenarios that are worth trying — a full scrollback, a SASL handshake — from
 * being the ones nobody remembers how to set up.
 *
 * Usage:
 *   node scripts/dev/mock-server.mjs [--port 6667] [--flood 200] [--sasl user:pass]
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);

function takeValue(flag, fallback) {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;

  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`${flag} needs a value`);
    process.exit(2);
  }

  args.splice(index, 2);
  return value;
}

const port = takeValue('--port', '6667');
const flood = takeValue('--flood', '0');
const sasl = takeValue('--sasl', null);

if (args.length > 0) {
  console.error(`unknown option: ${args.join(' ')}`);
  process.exit(2);
}

const env = {
  ...process.env,
  IRCUIT_TESTSERVER_PORT: String(port),
  IRCUIT_TESTSERVER_FLOOD: String(flood),
};

if (sasl !== null) {
  const separator = sasl.indexOf(':');
  if (separator <= 0) {
    console.error('--sasl expects account:password');
    process.exit(2);
  }

  env.IRCUIT_TESTSERVER_REQUIRE_SASL = '1';
  env.IRCUIT_TESTSERVER_ACCOUNT = sasl.slice(0, separator);
  env.IRCUIT_TESTSERVER_PASSWORD = sasl.slice(separator + 1);
}

console.log(`starting the mock IRC server on 127.0.0.1:${port}`);
if (Number(flood) > 0) console.log(`  plus ${flood} filler messages after every join`);
if (sasl !== null) console.log('  SASL required');

const result = spawnSync(
  process.execPath,
  ['scripts/run-cargo.mjs', 'run', '-p', 'ircuit-testserver', '--bin', 'ircuit-testserver'],
  { stdio: 'inherit', env },
);

process.exit(result.status ?? 1);
