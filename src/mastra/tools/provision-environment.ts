import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as registry from "../../registry/client.js";
import { deployStack } from "../../cdk/provisioner.js";

export const provisionEnvironment = createTool({
  id: "provisionEnvironment",
  description:
    "Provision a new scoped AWS environment for a hack project. v1 supports exactly one " +
    "stack type: node-api-postgres (an ECS Fargate Node API behind an ALB, backed by an " +
    "RDS Postgres database). Always confirm the project name with the user before calling " +
    "this — it costs real AWS money and creates a registry entry immediately.",
  inputSchema: z.object({
    projectName: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9-]+$/, "use lowercase letters, numbers, and hyphens only")
      .describe("Short project identifier, e.g. 'recipe-finder'. Used in AWS resource names."),
    stackType: z
      .enum(["node-api-postgres"])
      .default("node-api-postgres")
      .describe("The provisionable stack template. Only 'node-api-postgres' exists in v1."),
    tier: z
      .enum(["small", "medium", "large"])
      .default("small")
      .describe("Controls Fargate task size and RDS instance class."),
  }),
  outputSchema: z.object({
    environmentId: z.string(),
    status: z.enum(["healthy", "failed"]),
    apiUrl: z.string().optional(),
    dbEndpoint: z.string().optional(),
    ecrRepositoryName: z.string().optional(),
    ecsClusterName: z.string().optional(),
    ecsServiceName: z.string().optional(),
    errorMessage: z.string().optional(),
  }),
  execute: async ({ projectName, stackType, tier }, { requestContext }) => {
    const createdBy = requestContext.get("slackUserId") as string | undefined;
    const slackChannelId = requestContext.get("slackChannelId") as string | undefined;
    const slackThreadTs = requestContext.get("slackThreadTs") as string | undefined;

    const record = await registry.createEnvironment({
      projectName,
      stackType,
      createdBy: createdBy ?? "unknown",
      slackChannelId,
      slackThreadTs,
    });

    try {
      const result = await deployStack({
        projectName,
        environmentId: record.environmentId,
        stackType,
        tier,
      });

      await registry.updateEnvironmentStatus(record.environmentId, "healthy", {
        resources: result.resourceArns,
        outputs: result.outputs,
      });

      return {
        environmentId: record.environmentId,
        status: "healthy" as const,
        apiUrl: result.outputs.ApiUrl,
        dbEndpoint: result.outputs.DbEndpoint,
        ecrRepositoryName: result.outputs.EcrRepositoryName,
        ecsClusterName: result.outputs.EcsClusterName,
        ecsServiceName: result.outputs.EcsServiceName,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await registry.updateEnvironmentStatus(record.environmentId, "failed", { errorMessage });

      return {
        environmentId: record.environmentId,
        status: "failed" as const,
        errorMessage,
      };
    }
  },
});
