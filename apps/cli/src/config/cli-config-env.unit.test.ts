import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Config, ConfigProvider, Effect, FileSystem, Option, Path } from "effect";

import { useTempWorkdir } from "../../tests/helpers/command-mocks.ts";
import { loadProjectEnv } from "../command-internal/db-config.toml-read.ts";
import { loadCliProjectEnvFiles, readShellEnvironment } from "./cli-config-env.ts";

const withShell = (shell: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromEnvRecord(shell, { preserveEmptyStrings: true }));

describe("ambient ConfigProvider", () => {
  it.effect("yields Some('') for a set-but-empty variable when empty strings are preserved", () =>
    Effect.gen(function* () {
      const value = yield* Config.option(Config.string("SUPABASE_EMPTY"));

      expect(value).toEqual(Option.some(""));
    }).pipe(Effect.provide(withShell({ SUPABASE_EMPTY: "" }))),
  );

  it.effect("reports every variable it exposes, including empty and underscore-heavy names", () =>
    Effect.gen(function* () {
      const variables = yield* readShellEnvironment();

      expect(Object.fromEntries(variables)).toEqual({
        SUPABASE_EMPTY: "",
        SUPABASE_DB__PORT: "1",
        DOTENV_PRIVATE_KEY: "a",
        DOTENV_PRIVATE_KEY_PRODUCTION: "b",
        PLAIN: "c",
      });
    }).pipe(
      Effect.provide(
        withShell({
          SUPABASE_EMPTY: "",
          SUPABASE_DB__PORT: "1",
          DOTENV_PRIVATE_KEY: "a",
          DOTENV_PRIVATE_KEY_PRODUCTION: "b",
          PLAIN: "c",
        }),
      ),
    ),
  );
});

describe("project env loader", () => {
  const workdir = useTempWorkdir("supabase-cli-config-env-");

  const write = (relative: string, contents: string) => {
    const target = join(workdir.current, relative);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  };

  const fixtures: ReadonlyArray<{
    readonly name: string;
    readonly files: Readonly<Record<string, string>>;
    readonly shell: Readonly<Record<string, string>>;
  }> = [
    {
      name: "first writer wins across the env-specific, local and plain files",
      files: {
        "supabase/.env": "A=plain\nB=plain\nC=plain",
        "supabase/.env.local": "A=local\nB=local",
        "supabase/.env.development": "A=dev",
        "supabase/.env.development.local": "A=dev-local",
      },
      shell: {},
    },
    {
      name: "supabase/ is read before the project root",
      files: { "supabase/.env": "A=nested", ".env": "A=root\nB=root" },
      shell: {},
    },
    {
      name: "SUPABASE_ENV selects the env-specific files",
      files: { "supabase/.env.staging": "A=staging", "supabase/.env.development": "A=dev" },
      shell: { SUPABASE_ENV: "staging" },
    },
    {
      name: "the test env skips .env.local",
      files: { "supabase/.env.local": "A=local", "supabase/.env.test": "A=test" },
      shell: { SUPABASE_ENV: "test" },
    },
    {
      name: "an empty SUPABASE_ENV falls back to development",
      files: { "supabase/.env.development": "A=dev" },
      shell: { SUPABASE_ENV: "" },
    },
    {
      name: "a shell variable shadows the files even when it is empty",
      files: { "supabase/.env": "A=file\nB=file\nC=file" },
      shell: { A: "shell", B: "" },
    },
    {
      name: "godotenv quoting and variable expansion",
      files: { "supabase/.env": 'BASE=one\nQUOTED="two words"\nCOMBINED="${BASE}-x"\nexport E=1' },
      shell: {},
    },
  ];

  for (const fixture of fixtures) {
    it.effect(`matches the legacy loader: ${fixture.name}`, () =>
      Effect.gen(function* () {
        for (const [relative, contents] of Object.entries(fixture.files)) write(relative, contents);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const loaded = yield* loadCliProjectEnvFiles(workdir.current);
        const legacy = yield* loadProjectEnv(fs, path, workdir.current);

        expect(loaded.values).toEqual(legacy);
        expect(Object.keys(loaded.files).sort()).toEqual(Object.keys(legacy).sort());
      }).pipe(Effect.provide(BunServices.layer), Effect.provide(withShell(fixture.shell))),
    );
  }

  it.effect("records the file each value came from", () =>
    Effect.gen(function* () {
      write("supabase/.env.local", "A=local");
      write(".env", "B=root");

      const loaded = yield* loadCliProjectEnvFiles(workdir.current);

      expect(loaded.files).toEqual({
        A: join(workdir.current, "supabase", ".env.local"),
        B: join(workdir.current, ".env"),
      });
    }).pipe(Effect.provide(BunServices.layer), Effect.provide(withShell({}))),
  );

  it.effect("takes the shell from a pre-read snapshot instead of the provider", () =>
    Effect.gen(function* () {
      write("supabase/.env", "A=file\nB=file");

      const loaded = yield* loadCliProjectEnvFiles(workdir.current, {
        shell: new Map([["A", ""]]),
      });

      expect(loaded.values).toEqual({ B: "file" });
    }).pipe(Effect.provide(BunServices.layer), Effect.provide(withShell({}))),
  );

  it.effect("fails with the legacy text when a file is unreadable or malformed", () =>
    Effect.gen(function* () {
      mkdirSync(join(workdir.current, "supabase", ".env"), { recursive: true });
      const unreadable = yield* Effect.flip(loadCliProjectEnvFiles(workdir.current));
      expect(unreadable.message).toBe("failed to read environment file: .env");

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const legacyUnreadable = yield* Effect.flip(loadProjectEnv(fs, path, workdir.current));
      expect(unreadable.message).toBe(legacyUnreadable.message);
    }).pipe(Effect.provide(BunServices.layer), Effect.provide(withShell({}))),
  );

  it.effect("fails with the legacy text on a malformed line", () =>
    Effect.gen(function* () {
      write("supabase/.env.local", "not a valid line\n");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const failure = yield* Effect.flip(loadCliProjectEnvFiles(workdir.current));
      const legacy = yield* Effect.flip(loadProjectEnv(fs, path, workdir.current));

      expect(failure.message).toBe("failed to parse environment file: .env.local");
      expect(failure.message).toBe(legacy.message);
    }).pipe(Effect.provide(BunServices.layer), Effect.provide(withShell({}))),
  );
});
