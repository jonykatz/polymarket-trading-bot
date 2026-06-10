import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const dataDir = path.join(process.cwd(), ".data");
const lockPath = path.join(dataDir, "bot-instance.lock");
const STALE_LOCK_MS = 120_000;

type LockPayload = {
  pid: number;
  hostname: string;
  startedAt: string;
};

function readLock(): LockPayload | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8");
    return JSON.parse(raw) as LockPayload;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockIsStale(lock: LockPayload): boolean {
  const started = Date.parse(lock.startedAt);
  if (!Number.isFinite(started)) return true;
  return Date.now() - started > STALE_LOCK_MS && !isProcessAlive(lock.pid);
}

/** Prevent two live bots on the same machine sharing one wallet (Mac + droplet each need their own lock file). */
export function acquireInstanceLock(): void {
  fs.mkdirSync(dataDir, { recursive: true });

  const existing = readLock();
  if (existing && existing.pid !== process.pid) {
    if (isProcessAlive(existing.pid)) {
      throw new Error(
        `Another bot instance is already running (pid=${existing.pid}, host=${existing.hostname}, started=${existing.startedAt}). ` +
          `Stop it with "npm run pm2:stop" before starting live trading. See DROPLET.md §10.`
      );
    }
    if (!lockIsStale(existing)) {
      throw new Error(
        `bot-instance.lock held by pid=${existing.pid} on ${existing.hostname}. ` +
          `If no other bot is running, delete .data/bot-instance.lock and retry.`
      );
    }
  }

  const payload: LockPayload = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString()
  };
  fs.writeFileSync(lockPath, JSON.stringify(payload, null, 2), "utf-8");
}

export function releaseInstanceLock(): void {
  try {
    const existing = readLock();
    if (existing?.pid === process.pid) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // ignore
  }
}
