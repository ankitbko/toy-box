import { describe, expect, test } from "bun:test";
import {
  createAutomationRunSessionId,
  createAutomationReuseSessionId,
  getAutomationIdFromSessionId,
  isAutomationRunSession,
} from "./sessionId";

describe("automation session IDs", () => {
  test("encodes and decodes the automation ID for run sessions", () => {
    const automationId = "automation-123";
    const sessionId = createAutomationRunSessionId(automationId);

    expect(sessionId.startsWith("toy-box-auto-")).toBe(true);
    expect(getAutomationIdFromSessionId(sessionId)).toBe(automationId);
    expect(isAutomationRunSession(sessionId)).toBe(true);
  });

  test("encodes and decodes the automation ID for reuse sessions", () => {
    const automationId = "automation-456";
    const sessionId = createAutomationReuseSessionId(automationId);

    expect(sessionId).toBe("toy-box-auto-automation-456");
    expect(getAutomationIdFromSessionId(sessionId)).toBe(automationId);
    expect(isAutomationRunSession(sessionId)).toBe(true);
  });

  test("ignores non-automation session IDs", () => {
    expect(getAutomationIdFromSessionId("toy-box-abc")).toBeNull();
    expect(isAutomationRunSession("toy-box-abc")).toBe(false);
  });
});
