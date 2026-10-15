import type {
  SessionGoalStatus,
  SessionObserverHealth,
  SessionRunStatus,
} from "../../../packages/gateway-protocol/src/schema/sessions.js";

type RuntimeSessionRunReceipt = {
  /** Exact run owning the current terminal Gateway lifecycle projection. */
  runId: string;
  status: Exclude<SessionRunStatus, "queued" | "running">;
};

type RuntimeSessionGoalStatus = SessionGoalStatus | "none";

/** Bounded, current session facts for trusted background plugin classifiers. */
export type RuntimeSessionFacts = {
  key: string;
  sessionId: string;
  lifecycleRevision?: string;
  agentId: string;
  label?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  run: "active" | "idle" | "failed";
  /** Absent when no current terminal lifecycle projection is available. */
  runReceipt?: RuntimeSessionRunReceipt;
  /** Canonical current goal state; `none` means the prepared row has no goal. */
  goalStatus?: RuntimeSessionGoalStatus;
  observerDigest?: {
    health: SessionObserverHealth;
    runId?: string;
    headline: string;
    assessment?: string;
    revision: number;
  };
  pullRequests: Array<{ number: number; state: "open" | "draft" | "merged" | "closed" }>;
  /** Unknown or stale PR state must not be interpreted as a confirmed empty list. */
  pullRequestsUnavailable?: boolean;
  archived: boolean;
  lastActivityAt: number;
};

export type RuntimeSessionFactsResult = {
  sessions: RuntimeSessionFacts[];
  warnings?: string[];
};
