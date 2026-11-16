import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(
  new URL("../tests/fixtures/compiled-libpg-query.ts", import.meta.url),
);
const versionFixturePath = fileURLToPath(
  new URL("../tests/fixtures/compiled-cli-version.ts", import.meta.url),
);
const platformLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

describe("compiled binary assets", () => {
  it.live(
    "embeds and loads libpg-query.wasm",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-compiled-wasm-" });
        const executable = path.join(directory, "parser-probe");
        const bunExecutable = Bun.which("bun");
        if (!bunExecutable) {
          throw new Error("Bun executable not found");
        }

        const build = Bun.spawn(
          [bunExecutable, "build", fixturePath, "--compile", `--outfile=${executable}`],
          { stdout: "pipe", stderr: "pipe" },
        );
        const [buildExitCode, buildStderr] = yield* Effect.all(
          [
            Effect.promise(() => build.exited),
            Effect.promise(() => new Response(build.stderr).text()),
          ],
          { concurrency: "unbounded" },
        );
        expect(buildExitCode, buildStderr).toBe(0);

        const probe = Bun.spawn([executable], {
          cwd: directory,
          env: {},
          stdout: "pipe",
          stderr: "pipe",
        });
        const [probeExitCode, stdout, stderr] = yield* Effect.all(
          [
            Effect.promise(() => probe.exited),
            Effect.promise(() => new Response(probe.stdout).text()),
            Effect.promise(() => new Response(probe.stderr).text()),
          ],
          { concurrency: "unbounded" },
        );

        expect(probeExitCode, stderr).toBe(0);
        expect(stdout).toContain("libpg-query.wasm loaded");
      }).pipe(Effect.provide(platformLayer)),
    20_000,
  );

  it.live(
    "embeds the build version independently of the runtime environment",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-compiled-version-",
        });
        const executable = path.join(directory, "version-probe");
        const bunExecutable = Bun.which("bun");
        if (!bunExecutable) {
          throw new Error("Bun executable not found");
        }

        const build = Bun.spawn(
          [
            bunExecutable,
            "build",
            versionFixturePath,
            "--compile",
            `--define=SUPABASE_CLI_VERSION=${yield* encodeJson("7.8.9-beta.1")}`,
            `--outfile=${executable}`,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        const [buildExitCode, buildStderr] = yield* Effect.all(
          [
            Effect.promise(() => build.exited),
            Effect.promise(() => new Response(build.stderr).text()),
          ],
          { concurrency: "unbounded" },
        );
        expect(buildExitCode, buildStderr).toBe(0);

        const probe = Bun.spawn([executable], {
          cwd: directory,
          env: { SUPABASE_CLI_VERSION: "9.9.9" },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [probeExitCode, stdout, stderr] = yield* Effect.all(
          [
            Effect.promise(() => probe.exited),
            Effect.promise(() => new Response(probe.stdout).text()),
            Effect.promise(() => new Response(probe.stderr).text()),
          ],
          { concurrency: "unbounded" },
        );

        expect(probeExitCode, stderr).toBe(0);
        expect(stdout.trim()).toBe("7.8.9-beta.1");
      }).pipe(Effect.provide(platformLayer)),
    20_000,
  );
});
