import { Duration } from "aws-cdk-lib";
import * as ecs from "aws-cdk-lib/aws-ecs";

/**
 * Shared between every stack-type construct that runs on ECS Fargate — kept
 * here instead of duplicated per-construct so autoscaling behavior stays
 * consistent as more stack types get added.
 */
export interface AutoscalingConfig {
  readonly minCapacity: number;
  readonly maxCapacity: number;
}

export function applyAutoscaling(service: ecs.FargateService, config: AutoscalingConfig): void {
  const scaling = service.autoScaleTaskCount({
    minCapacity: config.minCapacity,
    maxCapacity: config.maxCapacity,
  });
  scaling.scaleOnCpuUtilization("CpuScaling", {
    targetUtilizationPercent: 60,
    scaleInCooldown: Duration.seconds(60),
    scaleOutCooldown: Duration.seconds(60),
  });
}
