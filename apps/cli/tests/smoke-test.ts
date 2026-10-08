import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { isPublishableNpmTag, PUBLISHABLE_NPM_TAGS_HINT } from "../scripts/release-channels.ts";

const { values } = parseArgs({
  options: {
    version: { type: "string", default: "0.0.1-smoke" },
    tag: { type: "string", default: "latest" },
  },
});

const version = values.version!;
const tag = values.tag;
if (!isPublishableNpmTag(tag)) {
  console.error(`Invalid --tag value: ${String(tag)}. Expected ${PUBLISHABLE_NPM_TAGS_HINT}.`);
  process.exit(1);
}
const testsDir = import.meta.dir;

const platformScripts: Record<string, string> = {
  linux: "smoke-test-linux.ts",
  darwin: "smoke-test-macos.ts",
  win32: "smoke-test-windows.ts",
};

const script = platformScripts[process.platform];
if (!script) {
  console.error(`Unsupported platform: ${process.platform}`);
  process.exit(1);
}

const scriptPath = path.join(testsDir, script);
console.log(`Detected platform: ${process.platform} — running ${script}\n`);

const proc = Bun.spawn(["bun", "run", scriptPath, "--version", version, "--tag", tag], {
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});

const exitCode = await proc.exited;
process.exit(exitCode);
