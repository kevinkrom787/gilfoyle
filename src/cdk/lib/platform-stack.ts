import { RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

/**
 * ONE-WAY DOOR: the environment registry lives in its own stack, deployed
 * once, independent of any per-project environment stack. Provisioning
 * (NodeApiPostgresEnvironment, and any future stack-type construct) must
 * stay decoupled from this stack — the registry is read/written by gilfoyle
 * tools and, later, by a monitoring agent that never touches CloudFormation
 * or CDK at all.
 */
export class GilfoylePlatformStack extends Stack {
  public readonly registryTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.registryTable = new dynamodb.Table(this, "EnvironmentRegistry", {
      tableName: "gilfoyle-environments",
      partitionKey: { name: "environmentId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Registry data should survive a stack teardown/redeploy — this is the
      // durable source of truth, not disposable infrastructure state.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.registryTable.addGlobalSecondaryIndex({
      indexName: "projectName-index",
      partitionKey: { name: "projectName", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
  }
}
