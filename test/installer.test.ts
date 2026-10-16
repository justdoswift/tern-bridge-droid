import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const installer = fileURLToPath(new URL('../install.sh', import.meta.url));
const id = 'tern-bridge-droid';

// Commands are real isolated executables, with a stateful stand-in for Tern's
// package boundary. Nothing invokes a provider, network, or the user's tools.
const commandFixture = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const env = process.env;
fs.appendFileSync(env.EVENTS, JSON.stringify({ name, args, cwd: process.cwd() }) + '\n');
const fail = phase => { if (env.FAIL === phase) process.exit(37); };
if (name === 'node') { console.log(env.NODE_VERSION || 'v22.0.0'); process.exit(0); }
if (name === 'bun') { console.log(env.BUN_VERSION || '1.3.14'); process.exit(0); }
if (name === 'uname') { console.log(args[0] === '-s' ? (env.OS || 'Darwin') : (env.ARCH || 'arm64')); process.exit(0); }
if (name === 'droid') throw new Error('Installer must not invoke the official CLI');
if (name === 'git') {
  if (args[0] === 'clone') {
    fs.mkdirSync(args.at(-1), { recursive: true });
    fail('clone');
  } else {
    fail('commit');
    console.log('0123456789abcdef0123456789abcdef01234567');
  }
  process.exit(0);
}
if (name === 'npm') {
  if (args[0] === 'ci') {
    fail('npm');
    fs.writeFileSync('dependencies-ready', 'yes');
  } else {
    assert.ok(fs.existsSync('dependencies-ready'));
    fail('build');
    if (env.FAIL === 'signal') { process.kill(process.ppid, 'SIGTERM'); process.exit(0); }
    if (env.FAIL !== 'missing-package') {
      fs.mkdirSync('artifacts/package/tern-bridge-droid', { recursive: true });
      fs.writeFileSync('artifacts/package/tern-bridge-droid/package', 'new-package');
    }
  }
  process.exit(0);
}
if (name === 'tern') {
  const target = path.join(env.TERN_CONFIG_DIR, 'plugins', args[1] === 'remove' ? args[2] : 'tern-bridge-droid');
  assert.equal(args[0], 'plugin');
  if (args[1] === 'remove') {
    fs.rmSync(target, { recursive: true, force: true });
  } else {
    assert.equal(args[1], 'install');
    fail('install');
    if (env.LINKED === '1' || (fs.existsSync(target) && !args.includes('--force'))) process.exit(9);
    const payload = fs.readFileSync(path.join(args[2], 'package'), 'utf8');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'package'), payload);
  }
  process.exit(0);
}
throw new Error('Unexpected command: ' + name);
`;

type Event = { name: string; args: string[]; cwd: string };

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'droid installer test '));
  const home = join(dir, 'private home');
  const config = join(dir, 'custom tern');
  const bin = join(dir, 'bin');
  const temporary = join(dir, 'temporary files');
  const eventsFile = join(dir, 'events');
  const packageFile = join(config, 'plugins', id, 'package');
  const preserved = [
    join(home, '.factory', 'auth.json'),
    join(home, '.zshrc'),
    join(config, 'plugin-data', id, 'sessions', 'history'),
    join(config, 'preferences.json'),
    join(config, 'plugins', 'unrelated', 'package'),
    join(temporary, 'unrelated sentinel'),
  ];
  for (const path of [home, config, bin, temporary]) await mkdir(path, { recursive: true });
  for (const path of preserved) {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, `preserve:${path}`);
  }
  for (const name of ['tern', 'git', 'node', 'npm', 'bun', 'droid', 'uname']) {
    await writeFile(join(bin, name), `#!${process.execPath}\n${commandFixture}`, { mode: 0o700 });
  }
  for (const name of ['mktemp', 'rm']) {
    const executable = ['/usr/bin', '/bin'].map(dir => join(dir, name)).find(existsSync);
    assert.ok(executable, `${name} must be available to the test harness`);
    await symlink(executable, join(bin, name));
  }
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: bin, TMPDIR: temporary,
    TERN_CONFIG_DIR: config, EVENTS: eventsFile, LC_ALL: 'C' };
  return {
    dir, bin, env, packageFile,
    async seed() {
      await mkdir(join(packageFile, '..'), { recursive: true });
      await writeFile(packageFile, 'old-package');
    },
    run(args: string[] = [], input?: string) {
      const result = spawnSync('/bin/bash', input === undefined ? [installer, ...args] : ['-s', '--', ...args],
        { cwd: home, env, input, encoding: 'utf8', timeout: 10_000 });
      assert.ifError(result.error);
      return result;
    },
    async events(): Promise<Event[]> {
      if (!existsSync(eventsFile)) return [];
      return (await readFile(eventsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
    async preserved(cliPresent = true) {
      for (const path of preserved) assert.equal(await readFile(path, 'utf8'), `preserve:${path}`);
      assert.deepEqual(await readdir(temporary), ['unrelated sentinel'], 'only installer-owned temporary directory is removed');
      if (cliPresent) assert.equal(await readFile(join(bin, 'droid'), 'utf8'), `#!${process.execPath}\n${commandFixture}`);
    },
    async dispose() { await rm(dir, { recursive: true, force: true }); },
  };
}

test('default install from stdin builds before native install and retains all user state', async () => {
  const f = await fixture();
  try {
    const result = f.run([], await readFile(installer, 'utf8'));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(f.packageFile, 'utf8'), 'new-package');
    await f.preserved();
  } finally { await f.dispose(); }
});

test('existing installations need explicit update; update can also install when missing', async t => {
  for (const existing of [false, true]) await t.test(`existing=${existing}`, async () => {
    const f = await fixture();
    try {
      if (existing) {
        await f.seed();
        const refused = f.run(['install']);
        assert.notEqual(refused.status, 0);
        assert.equal(await readFile(f.packageFile, 'utf8'), 'old-package');
      }
      const result = f.run(['update']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readFile(f.packageFile, 'utf8'), 'new-package');
      await f.preserved();
    } finally { await f.dispose(); }
  });
});

test('download and build failures never call install and preserve existing state', async t => {
  for (const phase of ['clone', 'commit', 'npm', 'build', 'missing-package', 'signal']) await t.test(phase, async () => {
    const f = await fixture();
    try {
      await f.seed();
      f.env.FAIL = phase;
      const result = f.run(['update']);
      assert.notEqual(result.status, 0, phase);
      assert.equal(await readFile(f.packageFile, 'utf8'), 'old-package');
      assert.equal((await f.events()).filter(e => e.name === 'tern').length, 0);
      await f.preserved();
    } finally { await f.dispose(); }
  });
});

test('native installation errors and linked installs remain protected', async t => {
  for (const linked of [false, true]) await t.test(`linked=${linked}`, async () => {
    const f = await fixture();
    try {
      await f.seed();
      if (linked) f.env.LINKED = '1'; else f.env.FAIL = 'install';
      assert.notEqual(f.run(['update']).status, 0);
      assert.equal(await readFile(f.packageFile, 'utf8'), 'old-package');
      assert.equal((await f.events()).filter(e => e.name === 'tern').length, 1);
      await f.preserved();
    } finally { await f.dispose(); }
  });
});

test('each missing required tool rejects before download or mutation', async t => {
  for (const tool of ['tern', 'git', 'node', 'npm', 'bun', 'droid']) await t.test(tool, async () => {
    const f = await fixture();
    try {
      await f.seed();
      await rm(join(f.bin, tool));
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.equal(await readFile(f.packageFile, 'utf8'), 'old-package');
      assert.equal((await f.events()).length, 0);
      await f.preserved(tool !== 'droid');
    } finally { await f.dispose(); }
  });
});

test('old and malformed runtime versions fail before download', async t => {
  for (const [key, value] of [['NODE_VERSION', 'v21.9.0'], ['NODE_VERSION', 'unknown'],
    ['BUN_VERSION', '1.3.13'], ['BUN_VERSION', '0.9.99'], ['BUN_VERSION', '1.3.14-canary']] as const) {
    await t.test(`${key}=${value}`, async () => {
      const f = await fixture();
      try {
        await f.seed();
        f.env[key] = value;
        assert.notEqual(f.run().status, 0);
        assert.equal(await readFile(f.packageFile, 'utf8'), 'old-package');
        assert.ok((await f.events()).every(e => ['node', 'bun'].includes(e.name)));
        await f.preserved();
      } finally { await f.dispose(); }
    });
  }
});

test('supported unverified targets warn and unsupported targets reject', async t => {
  for (const [os, arch, supported] of [['Linux', 'aarch64', true], ['Darwin', 'x86_64', true],
    ['Windows_NT', 'arm64', false], ['Linux', 'riscv64', false]] as const) {
    await t.test(`${os}/${arch}`, async () => {
      const f = await fixture();
      try {
        f.env.OS = os; f.env.ARCH = arch;
        const result = f.run();
        if (supported) {
          assert.equal(result.status, 0, result.stderr);
        } else {
          assert.notEqual(result.status, 0);
          assert.ok(!(await f.events()).some(e => ['git', 'npm', 'tern'].includes(e.name)));
        }
        await f.preserved();
      } finally { await f.dispose(); }
    });
  }
});

test('uninstall only needs tern, ignores platform gates and retains data and the official CLI', async () => {
  const f = await fixture();
  try {
    await f.seed();
    for (const name of ['git', 'node', 'npm', 'bun', 'uname', 'mktemp', 'rm']) await rm(join(f.bin, name));
    f.env.OS = 'unsupported';
    const result = f.run(['uninstall'], await readFile(installer, 'utf8'));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(f.packageFile), false);
    await f.preserved();
  } finally { await f.dispose(); }
});

test('unknown and extra arguments fail before any command; help needs no prerequisites', async t => {
  for (const args of [['invalid'], ['install', 'extra'], ['uninstall', 'extra'], ['--help', 'extra'], ['--help'], ['help']]) {
    await t.test(args.join(' '), async () => {
      const f = await fixture();
      try {
        await f.seed();
        await rm(join(f.bin, 'tern'));
        const result = f.run(args);
        assert.equal(result.status, args.length === 1 && ['help', '--help'].includes(args[0] ?? '') ? 0 : 2);
        assert.deepEqual(await f.events(), []);
        assert.equal(await readFile(f.packageFile, 'utf8'), 'old-package');
        await f.preserved();
      } finally { await f.dispose(); }
    });
  }
});

test('a truncated stdin download never executes installer actions', async () => {
  const f = await fixture();
  try {
    const source = await readFile(installer, 'utf8');
    // Exercise actual partial input, both inside a function and before invocation.
    for (const input of [source.slice(0, source.indexOf('  temporary=$(mktemp')), source.slice(0, source.lastIndexOf('main "$@"'))]) {
      f.run([], input);
      assert.deepEqual(await f.events(), []);
      await f.preserved();
    }
  } finally { await f.dispose(); }
});
