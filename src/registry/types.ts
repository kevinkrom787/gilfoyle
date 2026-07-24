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
  /**
   * ISO timestamp after which the reaper Lambda will auto-destroy this
   * environment if it's still "healthy". Set at creation from `ttlHours`.
   * Absent on records created before this field existed — those are never
   * matched by the reaper's expiry filter, so they're skipped, not reaped.
   */
  expiresAt?: string;
  /** Who tore this environment down — a human via destroyEnvironment, or the TTL reaper. */
  destroyedBy?: "user" | "ttl";
}

export interface CreateEnvironmentInput {
  projectName: string;
  stackType: StackType;
  createdBy: string;
  slackChannelId?: string;
  slackThreadTs?: string;
  /** Hours until auto-teardown. Defaults to DEFAULT_TTL_HOURS in registry/client.ts. */
  ttlHours?: number;
}
