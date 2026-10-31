import { BunPath } from "@effect/platform-bun";
import { Console, Effect, Path } from "effect";
import process from "node:process";
import { parseArgs } from "node:util";
import { isPublishableNpmTag, PUBLISHABLE_NPM_TAGS_HINT } from "../scripts/release-channels.ts";
import { ReleaseStepError } from "./helpers/release-shell.ts";

const { values } = parseArgs({
  options: {
    version: { type: "string", default: "0.0.1-smoke" },
    tag: { type: "string", default: "latest" },
  },
});

const version = values.version!;
const tag = values.tag;

const main = Effect.gen(function* () {
  if (!isPublishableNpmTag(tag)) {
    yield* Console.error(
      `Invalid --tag value: ${String(tag)}. Expected ${PUBLISHABLE_NPM_TAGS_HINT}.`,
    );
    return yield* Effect.sync(() => process.exit(1));
  }
  const testsDir = import.meta.dir;

  const platformScripts: Record<string, string> = {
    linux: "smoke-test-linux.ts",
    darwin: "smoke-test-macos.ts",
    win32: "smoke-test-windows.ts",
  };

  const script = platformScripts[process.platform];
  if (!script) {
    yield* Console.error(`Unsupported platform: ${process.platform}`);
    return yield* Effect.sync(() => process.exit(1));
  }

  const path = yield* Path.Path;
  const scriptPath = path.join(testsDir, script);
  yield* Console.log(`Detected platform: ${process.platform} — running ${script}\n`);

  const proc = yield* Effect.try({
    try: () =>
      Bun.spawn(["bun", "run", scriptPath, "--version", version, "--tag", tag], {
        stdout: "inherit",
        stderr: "inherit",
        env: process.env,
      }),
    catch: (cause) => new ReleaseStepError({ cause }),
  });

  const exitCode = yield* Effect.promise(() => proc.exited);
  return yield* Effect.sync(() => process.exit(exitCode));
});

await Effect.runPromise(
  main.pipe(
    Effect.catch((error) => Effect.die(error.cause)),
    Effect.provide(BunPath.layer),
  ),
);
