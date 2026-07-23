import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as registry from "../../registry/client.js";

export const getEnvironmentStatus = createTool({
  id: "getEnvironmentStatus",
  description:
    "Look up the current status of a single environment by its environmentId. v1 reads the " +
    "registry only — it does not make live AWS calls (that's the future monitoring agent's job).",
  inputSchema: z.object({
    environmentId: z.string(),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    environmentId: z.string(),
    projectName: z.string().optional(),
    stackType: z.string().optional(),
    status: z.string().optional(),
    outputs: z.record(z.string(), z.string()).optional(),
    errorMessage: z.string().optional(),
  }),
  execute: async ({ environmentId }) => {
    const record = await registry.getEnvironment(environmentId);

    if (!record) {
      return { found: false, environmentId };
    }

    return {
      found: true,
      environmentId: record.environmentId,
      projectName: record.projectName,
      stackType: record.stackType,
      status: record.status,
      outputs: record.outputs,
      errorMessage: record.errorMessage,
    };
  },
});
