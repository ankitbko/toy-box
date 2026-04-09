import { ensureSchedulerStarted } from "@/functions/automations/scheduler";
import { initAgentConfigFromEnv } from "@/functions/config";

export default function automationSchedulerPlugin(): void {
  console.log("[plugin] automationScheduler: initializing");
  void initAgentConfigFromEnv();
  ensureSchedulerStarted();
  console.log("[plugin] automationScheduler: scheduler started");
}
