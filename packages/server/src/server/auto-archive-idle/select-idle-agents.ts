import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

import type { StoredAgentRecord } from "../agent/agent-storage.js";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Live daemon state for one agent, narrowed to what the idle sweep needs. */
export interface IdleSweepLiveAgent {
  id: string;
  lifecycle: "initializing" | "idle" | "running" | "error" | "closed";
  activeTurnId: string | null;
  lastUserMessageAt: Date | null;
  pendingPermissionCount: number;
}

export interface SelectIdleAgentsInput {
  records: readonly StoredAgentRecord[];
  liveAgents: readonly IdleSweepLiveAgent[];
  idleDays: number;
  now: Date;
}

function toMillis(value: Date | string | null | undefined): number | null {
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isNaN(millis) ? null : millis;
  }
  if (typeof value === "string") {
    const millis = Date.parse(value);
    return Number.isNaN(millis) ? null : millis;
  }
  return null;
}

/**
 * Agents the idle sweep may archive: no user message inside `idleDays`, and not
 * busy in any way that a soft delete would interrupt.
 *
 * Subagents are excluded. They belong to their parent's lifecycle — the parent's
 * archive cascades to them — and an idle-looking child of an active parent is
 * still work the parent may come back to.
 */
export function selectIdleAgents(input: SelectIdleAgentsInput): string[] {
  const cutoff = input.now.getTime() - input.idleDays * DAY_MS;
  const liveById = new Map(input.liveAgents.map((agent) => [agent.id, agent] as const));

  return input.records
    .filter((record) => !record.archivedAt)
    .filter((record) => record.internal !== true)
    .filter((record) => record.labels?.[PARENT_AGENT_ID_LABEL] === undefined)
    .filter((record) => isIdleLongEnough(record, liveById.get(record.id), cutoff))
    .map((record) => record.id);
}

function isIdleLongEnough(
  record: StoredAgentRecord,
  live: IdleSweepLiveAgent | undefined,
  cutoff: number,
): boolean {
  if (live) {
    // Archive closes the runtime: never do that under a live turn.
    if (live.lifecycle === "running" || live.lifecycle === "initializing") return false;
    if (live.activeTurnId !== null) return false;
    // A pending permission is a question aimed at the user. Archiving discards it.
    if (live.pendingPermissionCount > 0) return false;
  }

  const lastInput =
    toMillis(live?.lastUserMessageAt) ??
    toMillis(record.lastUserMessageAt) ??
    toMillis(record.createdAt);

  return lastInput !== null && lastInput <= cutoff;
}
