#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const pluginDir = process.argv[2] ?? "/home/node/openclaw-plugins/feishu";
const distDir = path.join(pluginDir, "dist");
// Replace the OpenClaw ping probe so the manager bot can invite this bot to groups.
const pingPath = "/open-apis/bot/v1/openclaw_bot/ping";
const botInfoPath = "/open-apis/bot/v3/info";

async function listJavaScriptFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJavaScriptFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}

function patchProbeSource(source, filePath) {
  const requestPattern =
    /createFeishuClient\(creds\)\.request\(\{\s*method:\s*"POST",\s*url:\s*"\/open-apis\/bot\/v1\/openclaw_bot\/ping",\s*data:\s*\{\s*needBotInfo:\s*true\s*\},\s*timeout:\s*timeoutMs\s*\}\)/;
  const requestReplacement = `createFeishuClient(creds).request({
\t\t\t\tmethod: "GET",
\t\t\t\turl: "${botInfoPath}",
\t\t\t\ttimeout: timeoutMs
\t\t\t})`;

  let patched = source.replace(requestPattern, requestReplacement);
  patched = patched
    .replace("const botInfo = response.data?.pingBotInfo;", "const botInfo = response.bot;")
    .replace("botName: botInfo?.botName,", "botName: botInfo?.app_name,")
    .replace("botOpenId: botInfo?.botID", "botOpenId: botInfo?.open_id");

  if (patched === source) {
    throw new Error(`no changes applied to ${filePath}`);
  }
  if (patched.includes(pingPath) || patched.includes("needBotInfo") || patched.includes("pingBotInfo")) {
    throw new Error(`patched source still contains OpenClaw ping markers in ${filePath}`);
  }
  if (!patched.includes(botInfoPath) || !patched.includes("botOpenId: botInfo?.open_id")) {
    throw new Error(`patched source is missing standard bot info markers in ${filePath}`);
  }
  return patched;
}

const files = await listJavaScriptFiles(distDir);
const candidates = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  if (source.includes(pingPath)) {
    candidates.push({ file, source });
  }
}

if (candidates.length !== 1) {
  throw new Error(`expected exactly one Feishu probe file containing ${pingPath}, found ${candidates.length}`);
}

const [{ file, source }] = candidates;
await writeFile(file, patchProbeSource(source, file));
console.log(`[patch-openclaw-feishu-probe] patched ${path.relative(pluginDir, file)} to use ${botInfoPath}`);
