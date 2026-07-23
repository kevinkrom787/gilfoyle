# gilfoyle

A Slack agent, built on [Mastra.ai](https://mastra.ai), that provisions scoped AWS
infrastructure environments for hack projects. Tag `@gilfoyle` in Slack to provision,
list, check on, or destroy environments.

This is **v1**: one stack template (a Node.js API + Postgres), synchronous provisioning,
and simple tool-based agent logic. Later phases add monitoring agents that read the same
registry this version writes.

## Architecture at a glance

```
Slack (@gilfoyle mention)
  -> Bolt app (Socket Mode)
    -> Mastra agent "gilfoyle" (Claude Opus 4.8 via @ai-sdk/anthropic)
      -> tools: provisionEnvironment / destroyEnvironment / listEnvironments / getEnvironmentStatus
        -> src/cdk/provisioner.ts (shells out to `cdk deploy` / `cdk destroy`)
          -> CDK construct: NodeApiPostgresEnvironment (VPC, ECS Fargate + ALB, RDS Postgres, ECR)
        -> src/registry/client.ts (DynamoDB: gilfoyle-environments table)
```

The registry (DynamoDB) and the provisioning path (CDK) are two independent concerns —
see "One-way doors" below.

## One-way doors — don't casually change these

These three decisions were made deliberately as the foundation for later phases
(monitoring agents, more stack types). Changing them later is expensive; read before you
touch them.

1. **Registry schema is decoupled from CloudFormation state.**
   `src/registry/types.ts` (`EnvironmentRecord`) and `src/registry/client.ts` are the only
   source of truth for "what environments exist." A future monitoring agent should be
   able to read this DynamoDB table and query AWS (CloudWatch, Cost Explorer) directly —
   it should never need to go through gilfoyle's provisioning tools or CDK. Don't fold
   registry state into stack outputs only, and don't let the provisioner write directly
   to AWS APIs that bypass the registry.

2. **Every stack type is its own composable CDK construct with the same shape.**
   `src/cdk/lib/constructs/node-api-postgres-environment.ts` takes typed inputs
   (`projectName`, `environmentId`, `tier`) and exposes typed outputs (`apiUrl`,
   `dbEndpoint`, `ecrRepositoryName`, etc.) plus a `resourceArns` list. A second stack
   type (Python worker + SQS, static site + CloudFront, whatever) should be a new file
   implementing this same input/output shape, dispatched from
   `src/cdk/lib/environment-stack.ts` — not a rewrite of the tool or provisioner layers.

3. **Tagging is baked into the construct, not left to the agent.**
   `NodeApiPostgresEnvironment`'s constructor applies `project`, `environmentId`,
   `stackType`, and `createdBy=gilfoyle` tags via `Tags.of(this).add(...)` to every
   resource it creates. This is what makes every gilfoyle-created resource visible to
   future cost/monitoring tooling — untagged resources are expensive to retrofit. Any new
   construct must do the same in its own constructor.

Everything else (which stack template exists, sync vs. async provisioning, how smart the
agent is about picking parameters) is intentionally narrow in v1 and fine to change.

## Prerequisites (you set these up yourself)

- An AWS account with credentials available locally (`AWS_PROFILE`, or standard env vars,
  or an assumed role) — enough to run `cdk bootstrap` and `cdk deploy` in the target
  account/region.
- A Slack app + test workspace (see below).
- An Anthropic API key.
- Node.js 20+.

## Slack app setup

Create a Slack app at <https://api.slack.com/apps> (from scratch), then configure:

**OAuth & Permissions → Bot Token Scopes:**
- `app_mentions:read` — see `@gilfoyle` mentions
- `chat:write` — reply in channels/threads

**Event Subscriptions → Subscribe to bot events:**
- `app_mention`

**Socket Mode:**
- Enable Socket Mode (Settings → Socket Mode). This lets gilfoyle run without a public
  HTTPS endpoint — it connects outbound to Slack.
- Under **Basic Information → App-Level Tokens**, create a token with the
  `connections:write` scope. This is your `SLACK_APP_TOKEN` (`xapp-...`).

**Install the app** to your workspace (OAuth & Permissions → Install to Workspace), then
invite `@gilfoyle` to a channel.

Grab these three values for your `.env`:
- `SLACK_BOT_TOKEN` — OAuth & Permissions → Bot User OAuth Token (`xoxb-...`)
- `SLACK_SIGNING_SECRET` — Basic Information → App Credentials
- `SLACK_APP_TOKEN` — the app-level token you created above (`xapp-...`)

## Local setup

```bash
cd gilfoyle
npm install
cp .env.example .env
# fill in .env: SLACK_*, ANTHROPIC_API_KEY, AWS_REGION
```

Required env vars (see `.env.example` for the full list with comments):

| Var | Purpose |
|---|---|
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN` | Slack Bolt app |
| `ANTHROPIC_API_KEY` | Mastra agent model calls |
| `AWS_REGION` (+ standard AWS credential env vars / profile) | CDK deploys, DynamoDB access |
| `GILFOYLE_REGISTRY_TABLE` | DynamoDB table name (defaults to `gilfoyle-environments`) |
| `GILFOYLE_CDK_APP_DIR` | Directory the provisioner runs `cdk` from (defaults to `./src/cdk`) |
| `GILFOYLE_MEMORY_DB_PATH` | Local sqlite file for per-thread agent memory |

## Deploy the CDK platform stack (once)

The platform stack contains only the DynamoDB registry table and is independent of any
per-project environment stack:

```bash
npx cdk bootstrap   # first time only, per account/region
npm run cdk:deploy:platform
```

Per-environment stacks (`gilfoyle-<project>-<environmentId>`) are deployed
programmatically by the `provisionEnvironment` tool — you don't `cdk deploy` those by
hand. If you want to see what one would synthesize to:

```bash
npm run cdk:synth -- -c projectName=demo -c environmentId=preview -c stackType=node-api-postgres
```

## Run the bot locally

```bash
npm run dev
```

This starts the Bolt app in Socket Mode — no public URL or ngrok needed. In your Slack
test workspace:

```
@gilfoyle provision a node-api-postgres environment for project recipe-finder
@gilfoyle list environments
@gilfoyle what's the status of <environmentId>?
@gilfoyle destroy <environmentId>
```

## Wiring up real deploys (post-provision)

`provisionEnvironment` returns (and stores in the registry) an ECR repository name/URI
and an ECS cluster/service name. The container it deploys initially is a placeholder.
Copy `.github/workflows/deploy.yml` into the project's own repo, fill in `ECR_REPOSITORY`,
`ECS_CLUSTER`, `ECS_SERVICE`, and `AWS_ROLE_ARN`, and set up an OIDC-trusted IAM role for
GitHub Actions in that AWS account (no long-lived AWS keys):

```jsonc
// Trust policy for the GitHub OIDC role, scoped to your org/repo
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": "repo:<org>/<repo>:ref:refs/heads/main" }
    }
  }]
}
```

Grant that role `ecr:GetAuthorizationToken`/push permissions on the repo and
`ecs:UpdateService`/`DescribeServices` on the cluster/service. On push to `main`, the
workflow builds and pushes an image and force-deploys the ECS service.

## Project layout

```
src/
  mastra/
    agents/gilfoyle.ts       # system prompt, model, tools, memory
    tools/                    # provisionEnvironment, destroyEnvironment, listEnvironments, getEnvironmentStatus
    index.ts                  # Mastra instance
  registry/
    types.ts                  # EnvironmentRecord schema (one-way door)
    client.ts                 # DynamoDB data-access module
  cdk/
    lib/constructs/node-api-postgres-environment.ts  # the one v1 stack type (one-way door shape)
    lib/environment-stack.ts  # dispatches stackType -> construct
    lib/platform-stack.ts     # registry DynamoDB table
    bin/gilfoyle-cdk.ts      # CDK app entry
    provisioner.ts            # shells out to `cdk deploy` / `cdk destroy`
  slack/
    app.ts                    # Bolt app + app_mention handler
    index.ts                  # entry point
.github/workflows/deploy.yml  # template to copy into provisioned project repos
```

## Notes on the Mastra agent

- Model: `claude-opus-4-8` via `@ai-sdk/anthropic`.
- Extended thinking is intentionally **off** in v1 — the agent's job (pick among 4
  well-described tools, mostly in a single turn) doesn't need it, and it would add
  latency/cost for no real benefit at this scope. If the agent starts making poor calls on
  ambiguous requests as the tool surface grows, the lever is
  `providerOptions.anthropic.thinking` on the model call.
- Memory is per-Slack-thread (`threadId` = the Slack thread's `ts`), backed by a local
  SQLite file (`@mastra/libsql`), so follow-ups like "destroy that one" resolve against
  the environment just discussed in the same thread.

## Known gaps (by design, for v1)

- Provisioning is synchronous — the Slack reply blocks until `cdk deploy` finishes
  (several minutes). This is fine for a demo; if it becomes painful, formalize
  `provisionEnvironment` into a real Mastra Workflow with async status updates instead of
  changing the registry or construct shape.
- `getEnvironmentStatus` only reads the registry, not live AWS state — that's the seam a
  future monitoring agent fills in.
- Only one stack type. Adding a second is additive (see "One-way doors" above), not a
  rewrite.
