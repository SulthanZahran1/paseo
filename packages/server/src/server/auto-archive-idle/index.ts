import type { Logger } from "pino";

import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { DAY_MS, selectIdleAgents, type IdleSweepLiveAgent } from "./select-idle-agents.js";

/** A day-granularity policy does not need a finer sweep, and one storage list is cheap. */
export const IDLE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Let the daemon finish booting before the first sweep reads storage. */
export const IDLE_SWEEP_START_DELAY_MS = 60 * 1000;

export interface AutoArchiveIdleOptions {
  daemonConfigStore: Pick<DaemonConfigStore, "get">;
  agentManager: Pick<AgentManager, "listAgents" | "getAgent" | "archiveSnapshot">;
  agentStorage: Pick<AgentStorage, "list">;
  logger: Logger;
}

export interface AutoArchiveIdleTimer {
  unref?: () => void;
}

export interface AutoArchiveIdleDependencies {
  now: () => Date;
  setTimeout: (callback: () => void, delayMs: number) => AutoArchiveIdleTimer;
  clearTimeout: (handle: AutoArchiveIdleTimer) => void;
  setInterval: (callback: () => void, delayMs: number) => AutoArchiveIdleTimer;
  clearInterval: (handle: AutoArchiveIdleTimer) => void;
}

export interface AutoArchiveIdleHandle {
  /** Run one sweep now. Returns how many sessions it archived. */
  runNow: () => Promise<number>;
  stop: () => void;
}

const defaultDependencies: AutoArchiveIdleDependencies = {
  now: () => new Date(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

function toLiveAgent(agent: ManagedAgent): IdleSweepLiveAgent {
  return {
    id: agent.id,
    lifecycle: agent.lifecycle,
    activeTurnId: agent.activeTurnId,
    lastUserMessageAt: agent.lastUserMessageAt,
    pendingPermissionCount: agent.pendingPermissions.size,
  };
}

/**
 * Archives agent sessions that have gone `daemon.autoArchiveIdleDays` without a
 * user message. Off unless configured; the sweep re-reads the setting every run,
 * so turning it off stops the next sweep without a restart.
 */
export function setupAutoArchiveIdle(
  options: AutoArchiveIdleOptions,
  deps: AutoArchiveIdleDependencies = defaultDependencies,
): AutoArchiveIdleHandle {
  const log = options.logger.child({ module: "auto-archive-idle" });
  let intervalHandle: AutoArchiveIdleTimer | null = null;
  let startHandle: AutoArchiveIdleTimer | null = null;
  let inFlight = false;
  let stopped = false;

  const sweep = async (): Promise<number> => {
    const idleDays = options.daemonConfigStore.get().autoArchiveIdleDays ?? null;
    if (idleDays === null || inFlight) {
      return 0;
    }
    inFlight = true;
    try {
      const now = deps.now();
      const [records, liveAgents] = await Promise.all([
        options.agentStorage.list(),
        Promise.resolve(options.agentManager.listAgents().map(toLiveAgent)),
      ]);
      const agentIds = selectIdleAgents({ records, liveAgents, idleDays, now });
      const cutoff = now.getTime() - idleDays * DAY_MS;

      let archived = 0;
      for (const agentId of agentIds) {
        // A message can land between the sweep's snapshot and this archive. Re-check
        // the live record rather than archiving the session the user just typed into.
        const live = options.agentManager.getAgent(agentId);
        if (live?.lastUserMessageAt && live.lastUserMessageAt.getTime() > cutoff) {
          continue;
        }
        try {
          await options.agentManager.archiveSnapshot(agentId, now.toISOString());
          archived += 1;
          log.info({ agentId, idleDays }, "Archived idle agent session");
        } catch (error) {
          // One stuck agent must not stall the sweep for every other idle session.
          log.warn({ err: error, agentId }, "Failed to archive idle agent session");
        }
      }
      return archived;
    } catch (error) {
      log.warn({ err: error }, "Idle auto-archive sweep failed");
      return 0;
    } finally {
      inFlight = false;
    }
  };

  startHandle = deps.setTimeout(() => {
    startHandle = null;
    if (stopped) return;
    void sweep();
    intervalHandle = deps.setInterval(() => {
      void sweep();
    }, IDLE_SWEEP_INTERVAL_MS);
    intervalHandle.unref?.();
  }, IDLE_SWEEP_START_DELAY_MS);
  startHandle.unref?.();

  return {
    runNow: sweep,
    stop: () => {
      stopped = true;
      if (startHandle) {
        deps.clearTimeout(startHandle);
        startHandle = null;
      }
      if (intervalHandle) {
        deps.clearInterval(intervalHandle);
        intervalHandle = null;
      }
    },
  };
}
