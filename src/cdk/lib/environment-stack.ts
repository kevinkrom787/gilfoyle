import { CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  EnvironmentTier,
  NodeApiPostgresEnvironment,
} from "./constructs/node-api-postgres-environment.js";

export interface EnvironmentStackProps extends StackProps {
  readonly projectName: string;
  readonly environmentId: string;
  readonly stackType: string;
  readonly tier?: EnvironmentTier;
}

/**
 * Thin Stack wrapper around a stack-type construct. Adding a second stack
 * type means adding a branch here that instantiates the new construct — the
 * construct itself carries all the actual infrastructure, tagging, and
 * output logic. This file should stay dispatch-only.
 */
export class EnvironmentStack extends Stack {
  constructor(scope: Construct, id: string, props: EnvironmentStackProps) {
    super(scope, id, props);

    switch (props.stackType) {
      case "node-api-postgres": {
        const env = new NodeApiPostgresEnvironment(this, "Environment", {
          projectName: props.projectName,
          environmentId: props.environmentId,
          tier: props.tier,
        });

        new CfnOutput(this, "ApiUrl", { value: env.apiUrl });
        new CfnOutput(this, "DbEndpoint", { value: env.dbEndpoint });
        new CfnOutput(this, "DbSecretArn", { value: env.dbSecretArn });
        new CfnOutput(this, "EcrRepositoryName", { value: env.ecrRepositoryName });
        new CfnOutput(this, "EcrRepositoryUri", { value: env.ecrRepositoryUri });
        new CfnOutput(this, "EcsClusterName", { value: env.ecsClusterName });
        new CfnOutput(this, "EcsServiceName", { value: env.ecsServiceName });
        new CfnOutput(this, "VpcId", { value: env.vpcId });
        new CfnOutput(this, "ResourceArns", { value: JSON.stringify(env.resourceArns) });
        break;
      }
      default:
        throw new Error(
          `Unknown stackType "${props.stackType}". gilfoyle v1 only supports "node-api-postgres".`,
        );
    }
  }
}
