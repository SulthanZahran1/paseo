import { describe, expect, test } from "vitest";

import type { ManagedAgent } from "../agent/agent-manager.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import type { MutableDaemonConfig } from "../daemon-config-store.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  IDLE_SWEEP_INTERVAL_MS,
  IDLE_SWEEP_START_DELAY_MS,
  setupAutoArchiveIdle,
  type AutoArchiveIdleDependencies,
  type AutoArchiveIdleHandle,
  type AutoArchiveIdleOptions,
  type AutoArchiveIdleTimer,
} from "./index.js";
import { DAY_MS } from "./select-idle-agents.js";

const NOW = new Date("2026-10-28T12:00:00.000Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

function record(id: string, lastUserMessageAt: Date): StoredAgentRecord {
  return {
    id,
    provider: "claude",
    cwd: "/repo",
    createdAt: lastUserMessageAt.toISOString(),
    updatedAt: lastUserMessageAt.toISOString(),
    lastUserMessageAt: lastUserMessageAt.toISOString(),
    title: id,
    labels: {},
    lastStatus: "closed",
    config: null,
  } as unknown as StoredAgentRecord;
}

function liveAgent(id: string, lastUserMessageAt: Date): ManagedAgent {
  return {
    id,
    lifecycle: "closed",
    session: null,
    activeTurnId: null,
    lastUserMessageAt,
    pendingPermissions: new Map(),
  } as unknown as ManagedAgent;
}

interface Harness {
  options: AutoArchiveIdleOptions;
  deps: AutoArchiveIdleDependencies;
  archived: string[];
  start: () => AutoArchiveIdleHandle;
  sweepStart: () => void;
  fireInterval: () => void;
  setLiveAgents: (agents: ManagedAgent[]) => void;
  setRecords: (records: StoredAgentRecord[]) => void;
}

function createHarness(input: {
  idleDays: number | null;
  records: StoredAgentRecord[];
  liveAgents?: ManagedAgent[];
  failFor?: string[];
}): Harness {
  const archived: string[] = [];
  let records = input.records;
  let liveAgents = input.liveAgents ?? [];
  let startCallback: (() => void) | null = null;
  let intervalCallback: (() => void) | null = null;

  const options: AutoArchiveIdleOptions = {
    daemonConfigStore: {
      get: () => ({ autoArchiveIdleDays: input.idleDays }) as unknown as MutableDaemonConfig,
    },
    agentManager: {
      listAgents: () => liveAgents,
      getAgent: (agentId: string) => liveAgents.find((agent) => agent.id === agentId) ?? null,
      archiveSnapshot: async (agentId: string) => {
        if (input.failFor?.includes(agentId)) {
          throw new Error(`archive failed for ${agentId}`);
        }
        archived.push(agentId);
        return { id: agentId, archivedAt: NOW.toISOString() } as unknown as StoredAgentRecord;
      },
    } as unknown as AutoArchiveIdleOptions["agentManager"],
    agentStorage: { list: async () => records },
    logger: createTestLogger(),
  };

  const deps: AutoArchiveIdleDependencies = {
    now: () => NOW,
    setTimeout: (callback) => {
      startCallback = callback;
      return {} as AutoArchiveIdleTimer;
    },
    clearTimeout: () => {
      startCallback = null;
    },
    setInterval: (callback) => {
      intervalCallback = callback;
      return {} as AutoArchiveIdleTimer;
    },
    clearInterval: () => {
      intervalCallback = null;
    },
  };

  return {
    options,
    deps,
    archived,
    start: () => setupAutoArchiveIdle(options, deps),
    sweepStart: () => {
      if (!startCallback) throw new Error("start delay was cleared");
      startCallback();
    },
    fireInterval: () => {
      if (!intervalCallback) throw new Error("interval was not scheduled");
      intervalCallback();
    },
    setLiveAgents: (agents) => {
      liveAgents = agents;
    },
    setRecords: (next) => {
      records = next;
    },
  };
}

async function runOnce(harness: Harness): Promise<number> {
  const handle = harness.start();
  const archivedCount = await handle.runNow();
  handle.stop();
  return archivedCount;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("setupAutoArchiveIdle", () => {
  test("archives nothing while the setting is off", async () => {
    const harness = createHarness({
      idleDays: null,
      records: [record("old", daysAgo(9))],
      liveAgents: [liveAgent("old", daysAgo(9))],
    });

    expect(await runOnce(harness)).toBe(0);
    expect(harness.archived).toEqual([]);
  });

  test("archives only the sessions that passed the idle window", async () => {
    const harness = createHarness({
      idleDays: 2,
      records: [record("old", daysAgo(5)), record("fresh", daysAgo(1))],
      liveAgents: [liveAgent("old", daysAgo(5)), liveAgent("fresh", daysAgo(1))],
    });

    expect(await runOnce(harness)).toBe(1);
    expect(harness.archived).toEqual(["old"]);
  });

  test("keeps archiving the rest when one session fails to archive", async () => {
    const harness = createHarness({
      idleDays: 2,
      records: [record("stuck", daysAgo(5)), record("fine", daysAgo(5))],
      failFor: ["stuck"],
    });

    expect(await runOnce(harness)).toBe(1);
    expect(harness.archived).toEqual(["fine"]);
  });

  test("skips a session that received a message after the sweep listed it", async () => {
    const harness = createHarness({
      idleDays: 2,
      records: [record("typed-into", daysAgo(5))],
    });
    harness.setLiveAgents([liveAgent("typed-into", daysAgo(0.1))]);

    expect(await runOnce(harness)).toBe(0);
    expect(harness.archived).toEqual([]);
  });

  test("re-reads the setting every sweep, so clearing it skips the sweep", async () => {
    const harness = createHarness({
      idleDays: 2,
      records: [record("old", daysAgo(5))],
    });

    const handle = harness.start();
    expect(await handle.runNow()).toBe(1);

    const disabledOptions: AutoArchiveIdleOptions = {
      ...harness.options,
      daemonConfigStore: {
        get: () => ({ autoArchiveIdleDays: null }) as unknown as MutableDaemonConfig,
      },
    };
    const disabledHandle = setupAutoArchiveIdle(disabledOptions, harness.deps);
    expect(await disabledHandle.runNow()).toBe(0);

    handle.stop();
    disabledHandle.stop();
    expect(harness.archived).toEqual(["old"]);
  });

  test("sweeps once after the start delay, then on every interval tick", async () => {
    const harness = createHarness({
      idleDays: 2,
      records: [record("old", daysAgo(5))],
      liveAgents: [liveAgent("old", daysAgo(5))],
    });
    const handle = harness.start();

    expect(harness.archived).toEqual([]);
    harness.sweepStart();
    await flush();
    expect(harness.archived).toEqual(["old"]);

    harness.setRecords([record("older", daysAgo(7))]);
    harness.setLiveAgents([]);
    harness.fireInterval();
    await flush();
    expect(harness.archived).toEqual(["old", "older"]);

    handle.stop();
  });

  test("stop() before the start delay means no sweep ever runs", () => {
    const harness = createHarness({
      idleDays: 2,
      records: [record("old", daysAgo(5))],
    });
    const handle = harness.start();

    handle.stop();

    expect(() => harness.sweepStart()).toThrow("start delay was cleared");
    expect(harness.archived).toEqual([]);
  });

  test("sweeps hourly after a one-minute start delay", () => {
    expect(IDLE_SWEEP_START_DELAY_MS).toBe(60_000);
    expect(IDLE_SWEEP_INTERVAL_MS).toBe(60 * 60 * 1000);
  });
});
