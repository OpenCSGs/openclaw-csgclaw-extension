import { defineChannelPluginEntry, emptyChannelConfigSchema } from "openclaw/plugin-sdk/core";
import { csgclawPlugin } from "./src/channel.js";

export { csgclawPlugin } from "./src/channel.js";

export default defineChannelPluginEntry({
  id: "csgclaw",
  name: "CSGClaw",
  description: "CSGClaw IM bridge channel (participant SSE + REST API).",
  plugin: csgclawPlugin,
  configSchema: emptyChannelConfigSchema,
});
