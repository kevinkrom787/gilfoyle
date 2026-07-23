import "dotenv/config";
import { app } from "./app.js";

async function main() {
  await app.start();
  console.log("⚡️ gilfoyle is running (Socket Mode)");
}

main().catch((error) => {
  console.error("Failed to start gilfoyle:", error);
  process.exit(1);
});
