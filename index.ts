import { defineChannelPluginEntry, emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { csgclawPlugin } from "./src/channel.js";

export { csgclawPlugin } from "./src/channel.js";

export default defineChannelPluginEntry({
  id: "csgclaw",
  name: "CSGClaw",
  description: "CSGClaw IM bridge channel (CSGClaw bot bridge API).",
  plugin: csgclawPlugin,
  configSchema: emptyPluginConfigSchema,
});
