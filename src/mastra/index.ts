import { Mastra } from "@mastra/core/mastra";
import { gilfoyleAgent } from "./agents/gilfoyle.js";

export const mastra = new Mastra({
  agents: { gilfoyle: gilfoyleAgent },
});
