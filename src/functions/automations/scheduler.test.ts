import { describe, expect, onTestFinished, test } from "bun:test";
import type { Automation, AutomationsUpdateEvent } from "@/types";
import type { SessionStream } from "@/functions/runtime/stream";
import type { AutomationDatabase } from "./database";
import { runAutomation, setAutomationSchedulerDependenciesForTests } from "./scheduler";

function createAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: overrides.id ?? "automation-1",
    title: overrides.title ?? "Daily summary",
    prompt: overrides.prompt ?? "Summarize repository status.",
    model: overrides.model ?? "gpt-5",
    cron: overrides.cron ?? "0 9 * * *",
    reuseSession: overrides.reuseSession ?? true,
    cwd: overrides.cwd,
    createdAt: overrides.createdAt ?? "2026-02-14T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-02-14T10:00:00.000Z",
    nextRunAt: overrides.nextRunAt ?? "2026-02-15T09:00:00.000Z",
    lastRunAt: overrides.lastRunAt,
    lastRunSessionId: "lastRunSessionId" in overrides ? overrides.lastRunSessionId : "session-1",
  };
}

function createFakeDb(overrides: Partial<AutomationDatabase> = {}): AutomationDatabase {
  return {
    list: overrides.list ?? (async () => []),
    getById: overrides.getById ?? (async () => null),
    create: overrides.create ?? (async () => createAutomation()),
    update: overrides.update ?? (async () => null),
    remove: overrides.remove ?? (async () => true),
    updateLastRun: overrides.updateLastRun ?? (async () => {}),
    updateLastRunSessionId: overrides.updateLastRunSessionId ?? (async () => {}),
    claimDue: overrides.claimDue ?? (async () => []),
  } as unknown as AutomationDatabase;
}

function createFakeStream(): SessionStream {
  return {
    startTurn: () => {},
    invokeRemoteAgentPublic: async () => {},
    markSendFailure: () => {},
    detach: () => {},
  } as unknown as SessionStream;
}

describe("automation scheduler", () => {
  test("reuses the last session ID when reuseSession is true", async () => {
    onTestFinished(() => {
      setAutomationSchedulerDependenciesForTests();
    });

    const automation = createAutomation({
      id: "reuse-automation",
      prompt: "run with reuse",
      reuseSession: true,
      lastRunSessionId: "session-reused",
    });

    setAutomationSchedulerDependenciesForTests({
      db: createFakeDb({
        getById: async () => automation,
      }),
      deleteSession: async () => {},
      createSession: async (sessionId) => sessionId,
      updateSessionSummary: () => {},
      getOrCreateStream: () => createFakeStream(),
      emitAutomationsUpdate: () => {},
    });

    const result = await runAutomation(automation.id);

    // When reuseSession is true and lastRunSessionId exists, the same ID is reused
    // without calling deleteSession or createSession (platform session stays alive)
    expect(result).toEqual({ sessionId: "session-reused" });
  });

  test("generates a new session ID when reuseSession is true but no prior session exists", async () => {
    onTestFinished(() => {
      setAutomationSchedulerDependenciesForTests();
    });

    const automation = createAutomation({
      id: "reuse-no-prior",
      prompt: "first run",
      reuseSession: true,
      lastRunSessionId: undefined,
    });
    const createdSessionIds: string[] = [];

    setAutomationSchedulerDependenciesForTests({
      db: createFakeDb({
        getById: async () => automation,
      }),
      deleteSession: async () => {},
      createSession: async (sessionId) => {
        createdSessionIds.push(sessionId);
        return sessionId;
      },
      updateSessionSummary: () => {},
      getOrCreateStream: () => createFakeStream(),
      emitAutomationsUpdate: () => {},
    });

    const result = await runAutomation(automation.id);

    expect(createdSessionIds).toHaveLength(1);
    expect(createdSessionIds[0]).toStartWith("toy-box-auto-reuse-no-prior--run-");
    expect(result.sessionId).toBe(createdSessionIds[0]);
  });

  test("emits started event when automation runs", async () => {
    onTestFinished(() => {
      setAutomationSchedulerDependenciesForTests();
    });

    const automation = createAutomation({
      id: "success-automation",
      prompt: "run now",
      reuseSession: true,
      lastRunSessionId: "session-success",
    });
    const events: AutomationsUpdateEvent[] = [];

    setAutomationSchedulerDependenciesForTests({
      db: createFakeDb({
        getById: async () => automation,
      }),
      deleteSession: async () => {},
      createSession: async (sessionId) => sessionId,
      updateSessionSummary: () => {},
      getOrCreateStream: () => createFakeStream(),
      emitAutomationsUpdate: (event) => {
        events.push(event);
      },
    });

    const result = await runAutomation(automation.id);

    expect(result).toEqual({ sessionId: "session-success" });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("automation.started");
  });
});
