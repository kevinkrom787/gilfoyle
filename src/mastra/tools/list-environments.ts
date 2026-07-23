import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as registry from "../../registry/client.js";

export const listEnvironments = createTool({
  id: "listEnvironments",
  description:
    "List provisioned environments from the registry, optionally filtered by project name. " +
    "Use this to answer 'what environments exist' or 'what did I spin up for project X' questions.",
  inputSchema: z.object({
    projectName: z.string().optional().describe("Filter to a single project name."),
  }),
  outputSchema: z.object({
    environments: z.array(
      z.object({
        environmentId: z.string(),
        projectName: z.string(),
        stackType: z.string(),
        status: z.string(),
        createdBy: z.string(),
        createdAt: z.string(),
        apiUrl: z.string().optional(),
      }),
    ),
  }),
  execute: async ({ projectName }) => {
    const records = await registry.listEnvironments(projectName);

    return {
      environments: records.map((r) => ({
        environmentId: r.environmentId,
        projectName: r.projectName,
        stackType: r.stackType,
        status: r.status,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        apiUrl: r.outputs.ApiUrl,
      })),
    };
  },
});
