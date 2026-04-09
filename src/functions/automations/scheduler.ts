// Automation scheduler: polls for due automations and executes them.
//
// Each run creates a fresh platform session and invokes the remote agent.
// The scheduler also exposes `runAutomation` for on-demand manual runs.

import { createSession, deleteSession, hasAgentConfig } from "@/functions/state/sessionCache";
import { updateSessionSummary } from "@/functions/runtime/broadcast";
import { SessionStream } from "@/functions/runtime/stream";
import { createAutomationRunSessionId } from "@/lib/automation/sessionId";
import type { Automation } from "@/types";
import { getAppDatabase } from "@/functions/database";
import { AutomationDatabase } from "./database";
import { emitAutomationsUpdate } from "./events";

const AUTOMATION_SCHEDULER_POLL_MS = 30_000;

type AutomationSchedulerDependencies = {
  db: AutomationDatabase;
  deleteSession: typeof deleteSession;
  createSession: typeof createSession;
  updateSessionSummary: typeof updateSessionSummary;
  getOrCreateStream: (sessionId: string, initialModel?: string) => SessionStream;
  emitAutomationsUpdate: typeof emitAutomationsUpdate;
};

async function resolveDefaultDependencies(): Promise<AutomationSchedulerDependencies> {
  return {
    db: new AutomationDatabase(await getAppDatabase()),
    deleteSession,
    createSession,
    updateSessionSummary,
    getOrCreateStream: (sessionId, initialModel) =>
      SessionStream.getOrCreate(sessionId, initialModel),
    emitAutomationsUpdate,
  };
}

let activeDependencies: AutomationSchedulerDependencies | undefined;

/** Ensure the scheduler's polling loop is started */
let started = false;
export function ensureSchedulerStarted() {
  if (started) return;
  started = true;

  scheduleNextTick();
}

/** Poll for due automations and run them. */
let tickInProgress = false;
export async function runSchedulerTick() {
  if (tickInProgress) return;
  tickInProgress = true;

  try {
    // Skip if agent config is not yet available
    if (!hasAgentConfig()) {
      console.log("[scheduler] tick skipped: no agent config");
      return;
    }

    const dependencies = activeDependencies ?? (await resolveDefaultDependencies());
    activeDependencies = dependencies;
    const dueAutomations = await dependencies.db.claimDue();
    console.log(`[scheduler] tick: ${dueAutomations.length} due automations`);
    for (const automation of dueAutomations) {
      try {
        await runAutomation(automation.id);
      } catch (error) {
        console.error(`Failed to run scheduled automation ${automation.id}:`, error);
      }
    }
  } finally {
    tickInProgress = false;
    scheduleNextTick();
  }
}

/** Run an automation — reuses existing platform session or creates new one. */
export async function runAutomation(automationId: string): Promise<{ sessionId: string }> {
  const dependencies = activeDependencies ?? (await resolveDefaultDependencies());
  activeDependencies = dependencies;
  const automation = await dependencies.db.getById(automationId);
  if (!automation) {
    throw new Error("Automation not found");
  }

  const canReuseExisting = automation.reuseSession && automation.lastRunSessionId;
  const sessionId = canReuseExisting
    ? automation.lastRunSessionId!
    : createAutomationRunSessionId(automation.id);

  if (canReuseExisting) {
    // Reuse: close any active stream but keep the platform session alive.
    // Old events stay in SQLite until the new run's stream closes and replaces them.
    SessionStream.close(sessionId);
  } else {
    // New session: create on the platform
    await dependencies.createSession(sessionId, {
      model: automation.model,
      directory: automation.cwd,
    });
  }

  dependencies.updateSessionSummary(sessionId, automation.title, { replace: true });
  const stream = dependencies.getOrCreateStream(sessionId, automation.model);

  // Persist the session ID immediately so the automation list item is clickable
  await dependencies.db.updateLastRunSessionId(automation.id, sessionId);

  dependencies.emitAutomationsUpdate({
    type: "automation.started",
    automationId: automation.id,
    sessionId,
    startedAt: new Date().toISOString(),
  });

  try {
    stream.startTurn(automation.prompt);

    // Invoke the remote agent — completion is observed via the stream's subscriber
    stream
      .invokeRemoteAgentPublic(automation.prompt, automation.model)
      .then(() => {
        void finalizeAutomationRun(dependencies, {
          automationId: automation.id,
          sessionId,
          success: true,
          updateLastRun: true,
        });
      })
      .catch((error) => {
        console.error(`Automation ${automation.id} invocation failed:`, error);
        void finalizeAutomationRun(dependencies, {
          automationId: automation.id,
          sessionId,
          success: false,
          updateLastRun: true,
        });
      });

    return { sessionId };
  } catch (error) {
    stream.markSendFailure();
    stream.detach();
    await finalizeAutomationRun(dependencies, {
      automationId: automation.id,
      sessionId,
      success: false,
      updateLastRun: false,
    });
    throw error;
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

/** Persist the run result and emit a finished event to connected clients. */
async function finalizeAutomationRun(
  dependencies: AutomationSchedulerDependencies,
  options: {
    automationId: string;
    sessionId: string;
    success: boolean;
    updateLastRun: boolean;
  },
): Promise<void> {
  const finishedAt = new Date();
  let updatedAutomation: Automation | undefined;

  if (options.updateLastRun) {
    await dependencies.db.updateLastRun(options.automationId, finishedAt, options.sessionId);
    updatedAutomation = (await dependencies.db.getById(options.automationId)) ?? undefined;
  }

  dependencies.emitAutomationsUpdate({
    type: "automation.finished",
    automationId: options.automationId,
    sessionId: options.sessionId,
    finishedAt: finishedAt.toISOString(),
    success: options.success,
    automation: updatedAutomation,
  });
}

let timer = null as ReturnType<typeof setTimeout> | null;
function scheduleNextTick(delayMs = AUTOMATION_SCHEDULER_POLL_MS) {
  if (timer) {
    clearTimeout(timer);
  }

  timer = setTimeout(runSchedulerTick, delayMs);
}

// ============================================================================
// Test Seams
// ============================================================================

export function setAutomationSchedulerDependenciesForTests(
  overrides?: Partial<AutomationSchedulerDependencies>,
): void {
  if (!overrides) {
    activeDependencies = undefined;
    return;
  }

  activeDependencies = {
    db: overrides.db ?? ({} as AutomationDatabase),
    deleteSession: overrides.deleteSession ?? deleteSession,
    createSession: overrides.createSession ?? createSession,
    updateSessionSummary: overrides.updateSessionSummary ?? updateSessionSummary,
    getOrCreateStream:
      overrides.getOrCreateStream ??
      ((sessionId, initialModel) => SessionStream.getOrCreate(sessionId, initialModel)),
    emitAutomationsUpdate: overrides.emitAutomationsUpdate ?? emitAutomationsUpdate,
  };
}
