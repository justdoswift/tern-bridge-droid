import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { SessionLock } from '../src/session-lock.js';

async function directory(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'tern-bridge-lock-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}

async function ownerProcess(t: TestContext, root: string) {
  const moduleUrl = new URL('../src/session-lock.ts', import.meta.url).href;
  const script = `import { SessionLock } from ${JSON.stringify(moduleUrl)};
const lock = await SessionLock.acquire(process.argv[1], 'cross-process-session');
process.stdout.write('owned\\n');
process.stdin.once('data', async () => { await lock.release(); process.exit(0); });`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, root], { stdio: ['pipe', 'pipe', 'pipe'] });
  const ready = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.stdout.on('data', chunk => { if (String(chunk).includes('owned')) ready.resolve(); });
  child.on('error', error => { ready.reject(error); exited.resolve(); });
  child.on('exit', () => { ready.reject(new Error(`Lock owner exited before readiness: ${stderr}`)); exited.resolve(); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited.promise; });
  await ready.promise;
  return { child, exited: exited.promise };
}

test('a live owner in another process cannot be hijacked; a dead owner can be conservatively reclaimed', async t => {
  const root = await directory(t);
  const owner = await ownerProcess(t, root);
  await assert.rejects(SessionLock.acquire(root, 'cross-process-session'), /owned by plugin process/);
  owner.child.kill('SIGKILL'); await owner.exited;
  const replacement = await SessionLock.acquire(root, 'cross-process-session');
  await replacement.release();
});

test('an unverifiable lock owner is not assumed dead and no raw session file is involved', async t => {
  const root = await directory(t);
  const path = join(root, 'session-locks', `${createHash('sha256').update('unknown').digest('hex')}.lock`);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'owner.json'), '{interrupted write');
  await assert.rejects(SessionLock.acquire(root, 'unknown'), /no verifiable owner/);
  assert.equal(await readFile(join(path, 'owner.json'), 'utf8'), '{interrupted write');
});

test('release is idempotent and never deletes a replaced ownership token', async t => {
  const root = await directory(t);
  const first = await SessionLock.acquire(root, 'id');
  await Promise.all([first.release(), first.release()]);
  const second = await SessionLock.acquire(root, 'id');
  await first.release();
  await assert.rejects(SessionLock.acquire(root, 'id'), /owned by plugin process/);
  await second.release();
});
