import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { csgclawPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(csgclawPlugin);
