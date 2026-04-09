import { createServerFn } from "@tanstack/react-start";
import { zodValidator } from "@tanstack/zod-adapter";
import { z } from "zod";

const DEFAULT_API_VERSION = "2025-05-15-preview";

export const getRuntimeConfig = createServerFn({ method: "GET" }).handler(async () => {
  const envUrl = process.env.AGENT_BASE_URL ?? "";

  // Bootstrap server-side agent config from env on first request
  const { setAgentConfig, hasAgentConfig } = await import("./state/sessionCache");
  if (!hasAgentConfig() && envUrl) {
    setAgentConfig({ agentBaseUrl: envUrl, apiVersion: DEFAULT_API_VERSION });
  }

  return { agentBaseUrl: envUrl };
});

/** Set the agent URL from the client. Called on app load with the configured URL. */
export const setAgentUrl = createServerFn({ method: "POST" })
  .inputValidator(zodValidator(z.object({ agentBaseUrl: z.string().min(1) })))
  .handler(async ({ data }) => {
    const { setAgentConfig } = await import("./state/sessionCache");
    setAgentConfig({
      agentBaseUrl: data.agentBaseUrl,
      apiVersion: DEFAULT_API_VERSION,
    });
    return { success: true };
  });

/** Initialize agent config from environment variable on server startup */
export async function initAgentConfigFromEnv(): Promise<void> {
  const envUrl = process.env.AGENT_BASE_URL;
  if (envUrl) {
    const { setAgentConfig, hasAgentConfig } = await import("./state/sessionCache");
    if (!hasAgentConfig()) {
      setAgentConfig({
        agentBaseUrl: envUrl,
        apiVersion: DEFAULT_API_VERSION,
      });
    }
  }
}
