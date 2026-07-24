import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as registry from "../../registry/client.js";
import { deployStack } from "../../cdk/provisioner.js";

/** Regions that have actually been `cdk bootstrap`-ed. Keep in sync with reality. */
const SUPPORTED_REGIONS = ["us-east-1"] as const;

export const provisionEnvironment = createTool({
  id: "provisionEnvironment",
  description:
    "Provision a new scoped AWS environment for a hack project. Two stack types: " +
    "'node-api-postgres' (ECS Fargate Node API + ALB + RDS Postgres — for anything that " +
    "needs a database) and 'node-api' (same, no database — faster and cheaper, for " +
    "frontend-only or stateless projects). Ask the user which one fits before calling this, " +
    "along with region and whether they expect enough traffic to need autoscaling — don't " +
    "silently default. Always confirm the project name too — it costs real AWS money and " +
    "creates a registry entry immediately.",
  inputSchema: z.object({
    projectName: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9-]+$/, "use lowercase letters, numbers, and hyphens only")
      .describe("Short project identifier, e.g. 'recipe-finder'. Used in AWS resource names."),
    stackType: z
      .enum(["node-api-postgres", "node-api"])
      .describe(
        "'node-api-postgres' if the project needs a database, 'node-api' if it doesn't " +
          "(frontend-only, stateless, or data lives elsewhere). Ask, don't assume.",
      ),
    tier: z
      .enum(["small", "medium", "large"])
      .default("small")
      .describe("Controls Fargate task size (and RDS instance class, for node-api-postgres)."),
    region: z
      .enum(SUPPORTED_REGIONS)
      .default("us-east-1")
      .describe(
        `AWS region to deploy into. Currently bootstrapped/available: ${SUPPORTED_REGIONS.join(", ")}. ` +
          "If the user asks for a different region, tell them it isn't set up yet rather than " +
          "silently deploying somewhere else.",
      ),
    autoscaling: z
      .object({
        minCapacity: z.number().int().min(1).max(10),
        maxCapacity: z.number().int().min(1).max(10),
      })
      .optional()
      .describe(
        "Set this if the user expects meaningful/unpredictable traffic and wants the service " +
          "to scale on CPU utilization. Omit for a fixed single-task service (the default, and " +
          "right choice for most demos/hack projects).",
      ),
    ttlHours: z
      .number()
      .min(0.25)
      .max(24)
      .default(registry.DEFAULT_TTL_HOURS)
      .describe(
        "Hours until this environment is automatically torn down by the TTL reaper, " +
          "even if nobody destroys it manually. Default is 4 hours; max 24 — this tool " +
          "is for hack-project demos, not anything meant to run long-term.",
      ),
  }),
  outputSchema: z.object({
    environmentId: z.string(),
    status: z.enum(["healthy", "failed"]),
    apiUrl: z.string().optional(),
    dbEndpoint: z.string().optional(),
    ecrRepositoryName: z.string().optional(),
    ecsClusterName: z.string().optional(),
    ecsServiceName: z.string().optional(),
    expiresAt: z.string().optional(),
    errorMessage: z.string().optional(),
  }),
  execute: async (
    { projectName, stackType, tier, region, autoscaling, ttlHours },
    { requestContext },
  ) => {
    const createdBy = requestContext.get("slackUserId") as string | undefined;
    const slackChannelId = requestContext.get("slackChannelId") as string | undefined;
    const slackThreadTs = requestContext.get("slackThreadTs") as string | undefined;

    const record = await registry.createEnvironment({
      projectName,
      stackType,
      createdBy: createdBy ?? "unknown",
      slackChannelId,
      slackThreadTs,
      ttlHours,
      region,
    });

    try {
      const result = await deployStack({
        projectName,
        environmentId: record.environmentId,
        stackType,
        tier,
        region,
        autoscaling,
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
        expiresAt: record.expiresAt,
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
