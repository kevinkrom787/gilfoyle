import { Duration, RemovalPolicy, Tags } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import { Construct } from "constructs";
import { applyAutoscaling, type AutoscalingConfig } from "./shared.js";

/**
 * ONE-WAY DOOR: this is the interface every future stack-type construct must
 * follow — typed inputs in, typed outputs out, tagging baked into the
 * constructor. Do not add ad-hoc CDK code outside a construct implementing
 * this same shape; a second stack type should be a new file that looks like
 * this one, not a fork of the tool/provisioner layer.
 */
export type EnvironmentTier = "small" | "medium" | "large";

export interface NodeApiPostgresEnvironmentProps {
  /** Human-chosen project name, e.g. "recipe-finder". Used in resource names/tags. */
  readonly projectName: string;
  /** gilfoyle registry environmentId — the join key back to the registry table. */
  readonly environmentId: string;
  /** Controls Fargate task size and RDS instance class. Defaults to "small". */
  readonly tier?: EnvironmentTier;
  /** Fixed single-task service when omitted; scales on CPU when provided. */
  readonly autoscaling?: AutoscalingConfig;
}

const TIER_CONFIG: Record<
  EnvironmentTier,
  { cpu: number; memoryLimitMiB: number; dbInstanceClass: ec2.InstanceType }
> = {
  small: {
    cpu: 256,
    memoryLimitMiB: 512,
    dbInstanceClass: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
  },
  medium: {
    cpu: 512,
    memoryLimitMiB: 1024,
    dbInstanceClass: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
  },
  large: {
    cpu: 1024,
    memoryLimitMiB: 2048,
    dbInstanceClass: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
  },
};

/**
 * A Node.js API (ECS Fargate + ALB) backed by a Postgres database (RDS).
 * Composable and self-contained: a caller only needs `projectName` /
 * `environmentId` / `tier` in, and reads `apiUrl` / `dbEndpoint` / etc. out.
 *
 * For projects that don't need a database, see the sibling
 * `NodeApiEnvironment` construct instead — same shape, no RDS/NAT, much
 * faster to provision.
 */
export class NodeApiPostgresEnvironment extends Construct {
  public readonly apiUrl: string;
  public readonly dbEndpoint: string;
  public readonly dbSecretArn: string;
  public readonly ecrRepositoryName: string;
  public readonly ecrRepositoryUri: string;
  public readonly ecsClusterName: string;
  public readonly ecsServiceName: string;
  public readonly vpcId: string;
  /** Every ARN this construct provisioned — mirrored into the registry's `resources` field. */
  public readonly resourceArns: string[] = [];

  constructor(scope: Construct, id: string, props: NodeApiPostgresEnvironmentProps) {
    super(scope, id);

    const { projectName, environmentId } = props;
    const tier = props.tier ?? "small";
    const { cpu, memoryLimitMiB, dbInstanceClass } = TIER_CONFIG[tier];
    const namePrefix = `gilfoyle-${projectName}`;

    // --- Networking -----------------------------------------------------
    // No NAT gateway: the ECS task runs in a public subnet (locked down to
    // ALB-only inbound via security group, same as it would be behind a
    // NAT), and RDS stays fully isolated with no route out at all. This is
    // a deliberate demoware tradeoff — production workloads wanting the
    // task itself to have no public IP would bring the NAT gateway back.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "isolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    this.vpcId = vpc.vpcId;

    // --- Container registry ----------------------------------------------
    const repository = new ecr.Repository(this, "Repository", {
      repositoryName: `${namePrefix}-${environmentId.slice(0, 8)}`,
      imageScanOnPush: true,
      emptyOnDelete: true,
      // Hack-project environments are meant to fully disappear on
      // destroyEnvironment — nothing should be left behind still billing.
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.ecrRepositoryName = repository.repositoryName;
    this.ecrRepositoryUri = repository.repositoryUri;
    this.resourceArns.push(repository.repositoryArn);

    // --- Database ----------------------------------------------------------
    const dbSecurityGroup = new ec2.SecurityGroup(this, "DbSecurityGroup", {
      vpc,
      description: `Postgres access for ${namePrefix}`,
      allowAllOutbound: false,
    });

    const database = new rds.DatabaseInstance(this, "Database", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: dbInstanceClass,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSecurityGroup],
      credentials: rds.Credentials.fromGeneratedSecret("gilfoyle_admin"),
      databaseName: projectName.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 60),
      allocatedStorage: 20,
      storageEncrypted: true,
      backupRetention: Duration.days(1),
      deleteAutomatedBackups: true,
      deletionProtection: false,
      // Same reasoning as the ECR repository above: destroyEnvironment must
      // actually stop the billing, not leave a retained instance behind.
      removalPolicy: RemovalPolicy.DESTROY,
      publiclyAccessible: false,
    });
    this.dbEndpoint = database.dbInstanceEndpointAddress;
    this.dbSecretArn = database.secret!.secretArn;
    this.resourceArns.push(database.instanceArn, database.secret!.secretArn);

    // --- ECS Fargate service behind an ALB ---------------------------------
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      clusterName: `${namePrefix}-${environmentId.slice(0, 8)}`,
    });
    this.ecsClusterName = cluster.clusterName;
    this.resourceArns.push(cluster.clusterArn);

    const logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: `/gilfoyle/${namePrefix}-${environmentId.slice(0, 8)}`,
      retention: logs.RetentionDays.TWO_WEEKS,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDefinition", {
      cpu,
      memoryLimitMiB,
    });
    database.secret!.grantRead(taskDefinition.taskRole);

    // The task definition starts out pointing at the public httpd
    // placeholder, which needs no ECR auth — but the whole point of this
    // repository is for the project's own CI/CD to push a real image here
    // and force-redeploy onto it. Without this grant, the task's execution
    // role has no way to pull from it and every real deploy fails at
    // container startup with an ECR auth error.
    repository.grantPull(taskDefinition.executionRole!);

    const container = taskDefinition.addContainer("api", {
      // Placeholder image until the project's own GitHub Actions workflow
      // (.github/workflows/deploy.yml) pushes a real one and force-deploys.
      // Deliberately using httpd's zero-config default (port 80, no command
      // override) rather than trying to rewire it to a different port —
      // that requires knowing the image's exact entrypoint/CMD shape, which
      // is one more thing to get wrong for a container nobody keeps. A real
      // app deployed here should listen on 80 too (this is the port baked
      // into the ALB target group below); switch both together if you want
      // a non-privileged container port instead.
      image: ecs.ContainerImage.fromRegistry("public.ecr.aws/docker/library/httpd:latest"),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "api", logGroup }),
      environment: {
        PORT: "80",
        PROJECT_NAME: projectName,
        ENVIRONMENT_ID: environmentId,
      },
      secrets: {
        DB_CREDENTIALS: ecs.Secret.fromSecretsManager(database.secret!),
      },
      portMappings: [{ containerPort: 80 }],
    });
    void container;

    const service = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition,
      desiredCount: props.autoscaling?.minCapacity ?? 1,
      serviceName: `${namePrefix}-${environmentId.slice(0, 8)}`,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
    });
    this.ecsServiceName = service.serviceName;
    this.resourceArns.push(service.serviceArn);

    if (props.autoscaling) {
      applyAutoscaling(service, props.autoscaling);
    }

    dbSecurityGroup.addIngressRule(
      service.connections.securityGroups[0],
      ec2.Port.tcp(5432),
      "Allow API service to reach Postgres",
    );

    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
    });
    const listener = alb.addListener("Listener", { port: 80, open: true });
    listener.addTargets("ApiTargets", {
      port: 80,
      targets: [service],
      healthCheck: { path: "/", healthyHttpCodes: "200-499" },
    });
    this.resourceArns.push(alb.loadBalancerArn);

    this.apiUrl = `http://${alb.loadBalancerDnsName}`;

    // --- ONE-WAY DOOR: consistent tagging, baked into the construct -------
    // Every resource this construct creates gets these tags automatically.
    // Do not rely on the agent/tool layer to remember to tag things — a
    // future monitoring/cost agent depends on every gilfoyle resource
    // being tagged from the moment it's created.
    Tags.of(this).add("project", projectName);
    Tags.of(this).add("environmentId", environmentId);
    Tags.of(this).add("stackType", "node-api-postgres");
    Tags.of(this).add("createdBy", "gilfoyle");
  }
}
