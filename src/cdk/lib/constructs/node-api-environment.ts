import { RemovalPolicy, Tags } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { applyAutoscaling, type AutoscalingConfig } from "./shared.js";
import type { EnvironmentTier } from "./node-api-postgres-environment.js";

/**
 * ONE-WAY DOOR: same construct shape as NodeApiPostgresEnvironment (typed
 * inputs in, typed outputs out, tagging baked into the constructor) — see
 * the comment on that file. This is the second stack type the "additive,
 * not a rewrite" extensibility promise was actually meant to prove out.
 */
export interface NodeApiEnvironmentProps {
  readonly projectName: string;
  readonly environmentId: string;
  readonly tier?: EnvironmentTier;
  readonly autoscaling?: AutoscalingConfig;
}

const TIER_CONFIG: Record<EnvironmentTier, { cpu: number; memoryLimitMiB: number }> = {
  small: { cpu: 256, memoryLimitMiB: 512 },
  medium: { cpu: 512, memoryLimitMiB: 1024 },
  large: { cpu: 1024, memoryLimitMiB: 2048 },
};

/**
 * A Node.js API (ECS Fargate + ALB), no database. For projects that are
 * frontend-only or don't need persistence — meaningfully faster and cheaper
 * than NodeApiPostgresEnvironment since there's no RDS instance (the single
 * slowest resource in that stack) and no NAT gateway either.
 */
export class NodeApiEnvironment extends Construct {
  public readonly apiUrl: string;
  public readonly ecrRepositoryName: string;
  public readonly ecrRepositoryUri: string;
  public readonly ecsClusterName: string;
  public readonly ecsServiceName: string;
  public readonly vpcId: string;
  public readonly resourceArns: string[] = [];

  constructor(scope: Construct, id: string, props: NodeApiEnvironmentProps) {
    super(scope, id);

    const { projectName, environmentId } = props;
    const tier = props.tier ?? "small";
    const { cpu, memoryLimitMiB } = TIER_CONFIG[tier];
    const namePrefix = `gilfoyle-${projectName}`;

    // --- Networking ---------------------------------------------------
    // Public subnets only — no isolated tier needed since there's no
    // database, no NAT gateway needed since the task itself sits in a
    // public subnet (locked to ALB-only inbound via security group).
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });
    this.vpcId = vpc.vpcId;

    // --- Container registry ---------------------------------------------
    const repository = new ecr.Repository(this, "Repository", {
      repositoryName: `${namePrefix}-${environmentId.slice(0, 8)}`,
      imageScanOnPush: true,
      emptyOnDelete: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.ecrRepositoryName = repository.repositoryName;
    this.ecrRepositoryUri = repository.repositoryUri;
    this.resourceArns.push(repository.repositoryArn);

    // --- ECS Fargate service behind an ALB -------------------------------
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

    // The task definition starts out pointing at the public httpd
    // placeholder, which needs no ECR auth — but the whole point of this
    // repository is for the project's own CI/CD to push a real image here
    // and force-redeploy onto it. Without this grant, the task's execution
    // role has no way to pull from it and every real deploy fails at
    // container startup with an ECR auth error.
    repository.grantPull(taskDefinition.executionRole!);

    const container = taskDefinition.addContainer("api", {
      // Placeholder until the project's own GitHub Actions workflow
      // (.github/workflows/deploy.yml) pushes a real one and force-deploys.
      // httpd's zero-config default (port 80) — see the sibling
      // node-api-postgres construct for why we don't fight the image's
      // default port/entrypoint.
      image: ecs.ContainerImage.fromRegistry("public.ecr.aws/docker/library/httpd:latest"),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "api", logGroup }),
      environment: {
        PORT: "80",
        PROJECT_NAME: projectName,
        ENVIRONMENT_ID: environmentId,
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

    // --- ONE-WAY DOOR: consistent tagging, baked into the construct ------
    Tags.of(this).add("project", projectName);
    Tags.of(this).add("environmentId", environmentId);
    Tags.of(this).add("stackType", "node-api");
    Tags.of(this).add("createdBy", "gilfoyle");
  }
}
