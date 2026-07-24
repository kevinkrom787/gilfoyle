import { Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Default CDK bootstrap qualifier — unchanged since we've never passed
 * `--qualifier` to `cdk bootstrap`. If this account/region is ever
 * re-bootstrapped with a custom qualifier, update this constant to match.
 */
const CDK_BOOTSTRAP_QUALIFIER = "hnb659fds";

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

    // --- TTL auto-teardown reaper -----------------------------------------
    // Runs on a schedule independent of the Slack bot process — the whole
    // point is that an environment gets torn down even if the laptop
    // running `npm run dev` is closed or the bot has crashed. It calls
    // CloudFormation's DeleteStack directly (not `cdk destroy` — a Lambda
    // has no CDK CLI/project checkout), passing RoleARN so CloudFormation
    // assumes the CDK bootstrap's own execution role to do the actual
    // resource deletion. That keeps this function's own IAM role narrow:
    // it never needs EC2/RDS/ECS delete permissions itself.
    const cfnExecutionRoleArn = `arn:aws:iam::${this.account}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-cfn-exec-role-${this.account}-${this.region}`;

    const reaperFn = new NodejsFunction(this, "ReaperFunction", {
      entry: join(__dirname, "../../reaper/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: Duration.minutes(2),
      environment: {
        GILFOYLE_REGISTRY_TABLE: this.registryTable.tableName,
        CDK_EXECUTION_ROLE_ARN: cfnExecutionRoleArn,
      },
    });

    this.registryTable.grantReadWriteData(reaperFn);

    reaperFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudformation:DeleteStack", "cloudformation:DescribeStacks"],
        // Scoped to gilfoyle-provisioned environment stacks only — never
        // touches GilfoylePlatformStack itself or anything outside the
        // gilfoyle-* naming convention.
        resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/gilfoyle-*/*`],
      }),
    );

    reaperFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [cfnExecutionRoleArn],
      }),
    );

    new events.Rule(this, "ReaperSchedule", {
      description: "Checks for expired gilfoyle environments and tears them down",
      schedule: events.Schedule.rate(Duration.minutes(15)),
      targets: [new targets.LambdaFunction(reaperFn)],
    });
  }
}
