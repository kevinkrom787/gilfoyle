import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import type {
  CreateEnvironmentInput,
  EnvironmentRecord,
  EnvironmentStatus,
} from "./types.js";

/**
 * Typed data-access layer for the environment registry.
 *
 * This is a deliberately separate concern from CDK/provisioning: nothing in
 * this file knows about `cdk deploy`, stacks, or constructs. A future
 * monitoring agent should be able to import just this module (or query the
 * table directly) to read environment state and correlate it with live AWS
 * data, without touching gilfoyle's provisioning code at all.
 */

const TABLE_NAME = process.env.GILFOYLE_REGISTRY_TABLE ?? "gilfoyle-environments";

/** Default auto-teardown window for provisioned environments, in hours. */
export const DEFAULT_TTL_HOURS = 4;

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true },
});

export async function createEnvironment(
  input: CreateEnvironmentInput,
): Promise<EnvironmentRecord> {
  const now = new Date().toISOString();
  const ttlHours = input.ttlHours ?? DEFAULT_TTL_HOURS;
  const record: EnvironmentRecord = {
    environmentId: randomUUID(),
    projectName: input.projectName,
    stackType: input.stackType,
    status: "provisioning",
    resources: [],
    outputs: {},
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    slackChannelId: input.slackChannelId,
    slackThreadTs: input.slackThreadTs,
    expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString(),
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: record,
      ConditionExpression: "attribute_not_exists(environmentId)",
    }),
  );

  return record;
}

export async function getEnvironment(
  environmentId: string,
): Promise<EnvironmentRecord | undefined> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { environmentId },
    }),
  );
  return result.Item as EnvironmentRecord | undefined;
}

export async function listEnvironments(
  projectName?: string,
): Promise<EnvironmentRecord[]> {
  if (projectName) {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: "projectName-index",
        KeyConditionExpression: "projectName = :projectName",
        ExpressionAttributeValues: { ":projectName": projectName },
      }),
    );
    return (result.Items ?? []) as EnvironmentRecord[];
  }

  const result = await docClient.send(new ScanCommand({ TableName: TABLE_NAME }));
  return (result.Items ?? []) as EnvironmentRecord[];
}

/**
 * Environments the reaper Lambda should tear down: still "healthy" and past
 * their `expiresAt`. Records with no `expiresAt` (created before this field
 * existed) never match — they're skipped, not reaped.
 */
export async function listExpiredHealthyEnvironments(): Promise<EnvironmentRecord[]> {
  const result = await docClient.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: "#status = :healthy AND expiresAt <= :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":healthy": "healthy",
        ":now": new Date().toISOString(),
      },
    }),
  );
  return (result.Items ?? []) as EnvironmentRecord[];
}

export async function updateEnvironmentStatus(
  environmentId: string,
  status: EnvironmentStatus,
  opts: {
    resources?: string[];
    outputs?: Record<string, string>;
    errorMessage?: string;
    destroyedBy?: "user" | "ttl";
  } = {},
): Promise<void> {
  const sets = ["#status = :status", "updatedAt = :updatedAt"];
  const names: Record<string, string> = { "#status": "status" };
  const values: Record<string, unknown> = {
    ":status": status,
    ":updatedAt": new Date().toISOString(),
  };

  if (opts.resources) {
    sets.push("resources = :resources");
    values[":resources"] = opts.resources;
  }
  if (opts.outputs) {
    sets.push("outputs = :outputs");
    values[":outputs"] = opts.outputs;
  }
  if (opts.errorMessage) {
    sets.push("errorMessage = :errorMessage");
    values[":errorMessage"] = opts.errorMessage;
  }
  if (opts.destroyedBy) {
    sets.push("destroyedBy = :destroyedBy");
    values[":destroyedBy"] = opts.destroyedBy;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { environmentId },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}
