import type { StackType } from "../registry/types.js";
import type { EnvironmentTier } from "./lib/constructs/node-api-postgres-environment.js";
import type { AutoscalingConfig } from "./lib/constructs/shared.js";

/**
 * Shared by the local provisioner (src/cdk/provisioner.ts) and the reaper
 * Lambda (src/reaper/handler.ts) — both need to derive the same stack name
 * from a registry record, and must stay in sync. Kept dependency-free
 * (no execa, no fs) so the reaper's Lambda bundle stays small.
 */
export interface StackIdentity {
  projectName: string;
  environmentId: string;
  stackType: StackType;
  tier?: EnvironmentTier;
  region?: string;
  autoscaling?: AutoscalingConfig;
}

export function stackNameFor({
  projectName,
  environmentId,
}: Pick<StackIdentity, "projectName" | "environmentId">): string {
  return `gilfoyle-${projectName}-${environmentId}`;
}
