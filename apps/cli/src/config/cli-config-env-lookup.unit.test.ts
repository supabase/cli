import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Path, type PlatformError } from "effect";

import { useTempWorkdir } from "../../tests/helpers/command-mocks.ts";
import { CliConfigLoadError } from "../shared/config/cli-config-load.errors.ts";
import { CliEnvNameSource } from "../shared/config/cli-config-provider.layer.ts";
import { loadCliConfigEnvLookup } from "./cli-config-env-lookup.ts";

const withShell = (shell: Record<string, string>) =>
  Layer.merge(
    ConfigProvider.layer(ConfigProvider.fromEnvRecord(shell, { preserveEmptyStrings: true })),
    Layer.succeed(CliEnvNameSource, () => Object.keys(shell)),
  );

describe("loadCliConfigEnvLookup", () => {
  const workdir = useTempWorkdir("supabase-cli-env-lookup-");

  const write = (relative: string, contents: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const target = path.join(workdir.current, relative);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, contents);
    });

  const run = <A>(
    shell: Record<string, string>,
    body: Effect.Effect<
      A,
      CliConfigLoadError | PlatformError.PlatformError,
      FileSystem.FileSystem | Path.Path
    >,
  ) => body.pipe(Effect.provide(Layer.mergeAll(BunServices.layer, withShell(shell))));

  it.effect("prefers the shell, then the env-specific local file, then .env", () =>
    run(
      { SUPABASE_ENV: "staging", FROM_SHELL: "shell" },
      Effect.gen(function* () {
        yield* write("supabase/.env", "FROM_SHELL=file\nA=base\nB=base\nC=base");
        yield* write("supabase/.env.staging", "A=staging\nB=staging");
        yield* write("supabase/.env.staging.local", "A=staging-local");
        yield* write(".env", "C=workdir\nD=workdir");

        const env = yield* loadCliConfigEnvLookup(workdir.current, [
          "FROM_SHELL",
          "A",
          "B",
          "C",
          "D",
          "MISSING",
        ]);

        expect(env.lookup("FROM_SHELL")).toEqual({ state: "set", value: "shell" });
        expect(env.lookup("A")).toEqual({ state: "set", value: "staging-local" });
        expect(env.lookup("B")).toEqual({ state: "set", value: "staging" });
        expect(env.lookup("C")).toEqual({ state: "set", value: "base" });
        expect(env.lookup("D")).toEqual({ state: "set", value: "workdir" });
        expect(env.lookup("MISSING")).toEqual({ state: "unset" });
      }),
    ),
  );

  it.effect("skips .env.local when SUPABASE_ENV is test", () =>
    run(
      { SUPABASE_ENV: "test" },
      Effect.gen(function* () {
        yield* write("supabase/.env.local", "A=local");
        yield* write("supabase/.env.test", "A=test");

        const env = yield* loadCliConfigEnvLookup(workdir.current, ["A"]);

        expect(env.lookup("A")).toEqual({ state: "set", value: "test" });
      }),
    ),
  );

  it.effect("reports a shell empty string as empty and lets it mask a file value", () =>
    run(
      { A: "" },
      Effect.gen(function* () {
        yield* write("supabase/.env", "A=file");

        const env = yield* loadCliConfigEnvLookup(workdir.current, ["A"]);

        expect(env.lookup("A")).toEqual({ state: "empty", source: "shell" });
      }),
    ),
  );

  it.effect("reports a winning empty file value as empty", () =>
    run(
      {},
      Effect.gen(function* () {
        yield* write("supabase/.env", "A=\nB=value");

        const env = yield* loadCliConfigEnvLookup(workdir.current, ["A", "B"]);

        expect(env.lookup("A")).toEqual({ state: "empty", source: "file" });
        expect(env.lookup("B")).toEqual({ state: "set", value: "value" });
      }),
    ),
  );
});
