import process from "node:process";
import { parseArgs } from "node:util";
import { BunServices } from "@effect/platform-bun";
import { Effect, Path } from "effect";

const { values } = parseArgs({
  options: {
    version: { type: "string", default: "0.0.1-smoke" },
    tag: { type: "string", default: "latest" },
  },
});

const version = values.version!;
const tag = values.tag;
if (tag !== "latest" && tag !== "alpha" && tag !== "beta") {
  process.stderr.write(
    `Invalid --tag value: ${String(tag)}. Expected "latest", "alpha", or "beta".\n`,
  );
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
  process.stderr.write(`Unsupported platform: ${process.platform}\n`);
  process.exit(1);
}

const scriptPath = Effect.runSync(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(testsDir, script);
  }).pipe(Effect.provide(BunServices.layer)),
);
process.stdout.write(`Detected platform: ${process.platform} — running ${script}\n\n`);

const proc = Bun.spawn(["bun", "run", scriptPath, "--version", version, "--tag", tag], {
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});

const exitCode = await proc.exited;
process.exit(exitCode);
