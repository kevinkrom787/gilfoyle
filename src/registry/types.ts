/**
 * Environment registry schema — the "one-way door" central source of truth for
 * every environment gilfoyle provisions. This is intentionally decoupled from
 * CDK/CloudFormation: a future monitoring agent should be able to read this
 * table and query AWS directly (CloudWatch, Cost Explorer) without going
 * through gilfoyle's provisioning tools at all.
 */

export type EnvironmentStatus = "provisioning" | "healthy" | "failed" | "destroyed";

export type StackType = "node-api-postgres";

export interface EnvironmentRecord {
  environmentId: string;
  projectName: string;
  stackType: StackType;
  status: EnvironmentStatus;
  /** ARNs/identifiers of resources provisioned for this environment. */
  resources: string[];
  /** Stack outputs (endpoint URL, ECR repo, ECS cluster/service, DB info, ...). */
  outputs: Record<string, string>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  slackChannelId?: string;
  slackThreadTs?: string;
  /** Populated when status is "failed". */
  errorMessage?: string;
}

export interface CreateEnvironmentInput {
  projectName: string;
  stackType: StackType;
  createdBy: string;
  slackChannelId?: string;
  slackThreadTs?: string;
}
