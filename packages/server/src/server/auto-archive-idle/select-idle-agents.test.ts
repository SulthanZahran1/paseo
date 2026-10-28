import { describe, expect, test } from "vitest";

import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import { DAY_MS, selectIdleAgents, type IdleSweepLiveAgent } from "./select-idle-agents.js";

const NOW = new Date("2026-10-28T12:00:00.000Z");

function record(
  id: string,
  lastUserMessageAt: string | null,
  overrides: Partial<StoredAgentRecord> = {},
): StoredAgentRecord {
  return {
    id,
    provider: "claude",
    cwd: "/repo",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    lastUserMessageAt,
    title: id,
    labels: {},
    lastStatus: "closed",
    config: null,
    ...overrides,
  } as unknown as StoredAgentRecord;
}

function live(id: string, overrides: Partial<IdleSweepLiveAgent> = {}): IdleSweepLiveAgent {
  return {
    id,
    lifecycle: "idle",
    activeTurnId: null,
    lastUserMessageAt: null,
    pendingPermissionCount: 0,
    ...overrides,
  };
}

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

describe("selectIdleAgents", () => {
  test("selects a session whose last user message is older than the window", () => {
    const selected = selectIdleAgents({
      records: [record("old", daysAgo(3)), record("fresh", daysAgo(1))],
      liveAgents: [],
      idleDays: 2,
      now: NOW,
    });

    expect(selected).toEqual(["old"]);
  });

  test("treats a message exactly at the cutoff as idle", () => {
    const selected = selectIdleAgents({
      records: [record("boundary", daysAgo(2))],
      liveAgents: [],
      idleDays: 2,
      now: NOW,
    });

    expect(selected).toEqual(["boundary"]);
  });

  test("never selects an archived, internal, or subagent record", () => {
    const selected = selectIdleAgents({
      records: [
        record("archived", daysAgo(9), { archivedAt: "2026-10-02T00:00:00.000Z" }),
        record("internal", daysAgo(9), { internal: true }),
        record("subagent", daysAgo(9), { labels: { [PARENT_AGENT_ID_LABEL]: "parent" } }),
      ],
      liveAgents: [],
      idleDays: 2,
      now: NOW,
    });

    expect(selected).toEqual([]);
  });

  test("leaves sessions alone while they are initializing, running, or mid-turn", () => {
    const records = [
      record("init", daysAgo(9)),
      record("run", daysAgo(9)),
      record("turn", daysAgo(9)),
    ];
    const selected = selectIdleAgents({
      records,
      liveAgents: [
        live("init", { lifecycle: "initializing", lastUserMessageAt: new Date(daysAgo(9)) }),
        live("run", { lifecycle: "running", lastUserMessageAt: new Date(daysAgo(9)) }),
        live("turn", {
          lifecycle: "idle",
          activeTurnId: "turn_1",
          lastUserMessageAt: new Date(daysAgo(9)),
        }),
      ],
      idleDays: 2,
      now: NOW,
    });

    expect(selected).toEqual([]);
  });

  test("leaves a session waiting on a permission alone", () => {
    const selected = selectIdleAgents({
      records: [record("blocked", daysAgo(9))],
      liveAgents: [
        live("blocked", { lastUserMessageAt: new Date(daysAgo(9)), pendingPermissionCount: 1 }),
      ],
      idleDays: 2,
      now: NOW,
    });

    expect(selected).toEqual([]);
  });

  test("judges a live session by its newest message, not the stale stored record", () => {
    const selected = selectIdleAgents({
      records: [record("active", daysAgo(9))],
      liveAgents: [live("active", { lastUserMessageAt: new Date(daysAgo(1)) })],
      idleDays: 2,
      now: NOW,
    });

    expect(selected).toEqual([]);
  });

  test("falls back to createdAt for a session that never carried a message", () => {
    const selected = selectIdleAgents({
      records: [record("never-messaged", null, { createdAt: daysAgo(4) })],
      liveAgents: [],
      idleDays: 2,
      now: NOW,
    });

    expect(selected).toEqual(["never-messaged"]);
  });
});
