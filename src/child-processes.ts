import { spawn, execFileSync, type ChildProcess, type SpawnOptions } from 'child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';

/**
 * Owned-child tracking so startup/shutdown cleanup targets ONLY the Claude CLI
 * processes this instance spawned — never other Claudeway instances or the
 * developer's interactive `claude` sessions (the old host-wide
 * `pkill -9 -f "claude.*dangerously-skip-permissions"` matched all of them).
 *
 * PIDs are mirrored to a sidecar file next to the pidfile so a hard crash
 * (SIGKILL of the server) can still be reaped on the next startup, scoped to
 * exactly the PIDs we recorded rather than a host-wide pattern.
 */

const PIDS_FILE = resolve(process.cwd(), '.claudeway-children.pids');

/** PIDs of Claude children this instance owns and has not yet reaped. */
const ownedPids = new Set<number>();

function persist(): void {
  try {
    if (ownedPids.size === 0) {
      if (existsSync(PIDS_FILE)) unlinkSync(PIDS_FILE);
      return;
    }
    writeFileSync(PIDS_FILE, [...ownedPids].join('\n'), 'utf-8');
  } catch {
    // Best effort — losing the sidecar only costs cross-restart orphan reaping
  }
}

/** Spawn a `claude` child and track its pid for scoped cleanup. */
export function spawnTrackedClaude(args: string[], options: SpawnOptions): ChildProcess {
  const proc = spawn('claude', args, options);
  const { pid } = proc;
  if (pid) {
    ownedPids.add(pid);
    persist();
    proc.once('close', () => {
      ownedPids.delete(pid);
      persist();
    });
  }
  return proc;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Confirm a pid is actually a Claude CLI process before signalling it, so a
 * recycled pid (some unrelated program that reused the number after our child
 * exited) is never touched. Best effort — if `ps` is unavailable we decline to
 * kill rather than risk hitting the wrong process.
 */
function looksLikeClaude(pid: number): boolean {
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    return cmd.includes('claude');
  } catch {
    return false;
  }
}

/**
 * Reap Claude children left behind by a previous instance that crashed without
 * a graceful shutdown. Reads the recorded PIDs (this cwd's sidecar only),
 * verifies each still resolves to a Claude process, SIGTERMs it, then SIGKILLs
 * survivors after a short grace window. Call once at startup before any spawn.
 */
export function reapOrphanedChildren(): void {
  let recorded: number[];
  try {
    if (!existsSync(PIDS_FILE)) return;
    recorded = readFileSync(PIDS_FILE, 'utf-8')
      .split('\n')
      .map((l) => parseInt(l.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch {
    return;
  }

  const orphans = recorded.filter((pid) => pidIsAlive(pid) && looksLikeClaude(pid));
  for (const pid of orphans) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`[child-processes] Reaping orphaned Claude child from prior run (PID ${pid})`);
    } catch {
      // already gone
    }
  }
  if (orphans.length > 0) {
    // Escalate to SIGKILL for any that ignored the grace window, then clear.
    setTimeout(() => {
      for (const pid of orphans) {
        if (pidIsAlive(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // gone
          }
        }
      }
    }, 2000).unref?.();
  }

  ownedPids.clear();
  persist();
}

/**
 * Gracefully terminate every child this instance still owns: SIGTERM, wait up
 * to `graceMs` for exits, then SIGKILL survivors. Used on shutdown so in-flight
 * turns get a chance to finish cleanly instead of being SIGKILLed outright.
 */
export async function terminateOwnedChildren(graceMs = 2500): Promise<void> {
  const pids = [...ownedPids];
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      ownedPids.delete(pid);
    }
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && [...ownedPids].some((pid) => pidIsAlive(pid))) {
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const pid of ownedPids) {
    if (pidIsAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
  }
  ownedPids.clear();
  persist();
}
