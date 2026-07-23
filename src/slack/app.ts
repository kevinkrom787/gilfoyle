import pkg from "@slack/bolt";
import { RequestContext } from "@mastra/core/request-context";
import { mastra } from "../mastra/index.js";

const { App } = pkg;

const requiredEnv = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "SLACK_APP_TOKEN"] as const;
for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var ${key} — see .env.example`);
  }
}

export const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

function stripMention(text: string): string {
  return text.replace(/^\s*<@[^>]+>\s*/, "").trim();
}

app.event("app_mention", async ({ event, say, logger }) => {
  const threadTs = event.thread_ts ?? event.ts;
  const userText = stripMention(event.text ?? "");

  if (!userText) {
    await say({ text: "Yes? Tell me what to provision, destroy, or list.", thread_ts: threadTs });
    return;
  }

  const requestContext = new RequestContext();
  requestContext.set("slackUserId", event.user ?? "unknown");
  requestContext.set("slackChannelId", event.channel);
  requestContext.set("slackThreadTs", threadTs);

  try {
    const gilfoyle = mastra.getAgent("gilfoyle");
    const response = await gilfoyle.generate(userText, {
      memory: { thread: threadTs, resource: event.user ?? "unknown" },
      requestContext,
    });

    await say({ text: response.text || "(no response)", thread_ts: threadTs });
  } catch (error) {
    logger.error(error);
    await say({
      text: `Something went wrong handling that: ${error instanceof Error ? error.message : String(error)}`,
      thread_ts: threadTs,
    });
  }
});
