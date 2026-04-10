const AUTOMATION_SESSION_ID_PREFIX = "toy-box-auto-";
const AUTOMATION_SESSION_ID_RUN_SEPARATOR = "--run-";

/** Create a session ID for a one-off automation run (unique per run). */
export function createAutomationRunSessionId(automationId: string): string {
  return `${AUTOMATION_SESSION_ID_PREFIX}${automationId}${AUTOMATION_SESSION_ID_RUN_SEPARATOR}${crypto.randomUUID()}`;
}

/** Create a stable session ID for reuse-session automations (same across runs). */
export function createAutomationReuseSessionId(automationId: string): string {
  return `${AUTOMATION_SESSION_ID_PREFIX}${automationId}`;
}

export function getAutomationIdFromSessionId(sessionId: string): string | null {
  if (!sessionId.startsWith(AUTOMATION_SESSION_ID_PREFIX)) return null;

  const encoded = sessionId.slice(AUTOMATION_SESSION_ID_PREFIX.length);
  const separatorIndex = encoded.indexOf(AUTOMATION_SESSION_ID_RUN_SEPARATOR);
  if (separatorIndex <= 0) {
    // No run separator — this is a reuse session, the whole suffix is the automation ID
    return encoded.length > 0 ? encoded : null;
  }

  const automationId = encoded.slice(0, separatorIndex);
  return automationId.length > 0 ? automationId : null;
}

export function isAutomationRunSession(sessionId: string): boolean {
  return getAutomationIdFromSessionId(sessionId) !== null;
}
