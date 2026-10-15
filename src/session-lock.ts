import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class SessionLockError extends Error {}

function isErrno(error: unknown): error is { code: string } {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string';
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !isErrno(error) || error.code !== 'ESRCH'; }
}

interface Owner { pid: number; token: string }
async function owner(path: string): Promise<Owner | null> {
  try {
    const value: unknown = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
    if (value && typeof value === 'object' && 'pid' in value && 'token' in value &&
        typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0 &&
        typeof value.token === 'string') return { pid: value.pid, token: value.token };
  } catch { /* An incomplete or unreadable owner is not evidence of a dead process. */ }
  return null;
}

/** Coordinates this plugin's processes only; it cannot lock the standalone Droid CLI. */
export class SessionLock {
  private released = false;
  private constructor(private readonly path: string, private readonly token: string) {}

  static async acquire(dataDir: string, sessionId: string): Promise<SessionLock> {
    const root = join(dataDir, 'session-locks');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const path = join(root, `${createHash('sha256').update(sessionId).digest('hex')}.lock`);
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await mkdir(path, { mode: 0o700 });
        await writeFile(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
        return new SessionLock(path, token);
      } catch (error) {
        if (!isErrno(error) || error.code !== 'EEXIST') throw new SessionLockError('Cannot create the session lock. Check the plugin data directory permissions.');
      }
      // A reclaimer must take this gate BEFORE reading the owner. Otherwise two
      // reclaimers can rename a newly acquired lock after inspecting the old one.
      const gate = join(path, 'reclaim');
      try { await mkdir(gate, { mode: 0o700 }); }
      catch { throw new SessionLockError('Another plugin process is opening this session. Close that instance before resuming.'); }
      let moved = false;
      try {
        const current = await owner(path);
        if (!current || alive(current.pid)) {
          throw new SessionLockError(current
            ? `This session is owned by plugin process ${current.pid}. Close it before resuming here.`
            : 'The session lock has no verifiable owner. Confirm all plugin instances are closed before removing its lock in the plugin data directory.');
        }
        const retired = `${path}.retired-${token}`;
        await rename(path, retired);
        moved = true;
        await rm(retired, { recursive: true, force: true });
      } finally {
        if (!moved) await rm(gate, { recursive: true, force: true });
      }
    }
    throw new SessionLockError('The session lock changed while opening. Choose the session again.');
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    if ((await owner(this.path))?.token === this.token) await rm(this.path, { recursive: true, force: true });
  }
}
