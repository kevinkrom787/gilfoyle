import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as registry from "../../registry/client.js";
import { destroyStack } from "../../cdk/provisioner.js";

export const destroyEnvironment = createTool({
  id: "destroyEnvironment",
  description:
    "Tear down a previously provisioned environment and its CDK stack. Only call this when " +
    "the user explicitly names the environment (by environmentId or unambiguous project name) " +
    "to destroy — never as a side effect of something else.",
  inputSchema: z.object({
    environmentId: z.string().describe("The environmentId returned by provisionEnvironment."),
  }),
  outputSchema: z.object({
    environmentId: z.string(),
    status: z.enum(["destroyed", "failed"]),
    errorMessage: z.string().optional(),
  }),
  execute: async ({ environmentId }) => {
    const record = await registry.getEnvironment(environmentId);
    if (!record) {
      return {
        environmentId,
        status: "failed" as const,
        errorMessage: `No environment found with id ${environmentId}`,
      };
    }

    try {
      await destroyStack({
        projectName: record.projectName,
        environmentId: record.environmentId,
        stackType: record.stackType,
      });

      await registry.updateEnvironmentStatus(environmentId, "destroyed", { destroyedBy: "user" });

      return { environmentId, status: "destroyed" as const };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await registry.updateEnvironmentStatus(environmentId, "failed", { errorMessage });

      return { environmentId, status: "failed" as const, errorMessage };
    }
  },
});
