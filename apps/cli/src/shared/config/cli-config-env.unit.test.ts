import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Config, ConfigProvider, Effect, FileSystem, Layer, Option, Path } from "effect";

import { useTempWorkdir } from "../../../tests/helpers/command-mocks.ts";
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
      const shell = yield* readShellEnvironment();

      expect(Object.fromEntries(shell.entries())).toEqual({
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

describe("shell snapshot", () => {
  it.effect("reads names an orElse fallback provider holds", () =>
    Effect.gen(function* () {
      const shell = yield* readShellEnvironment({ names: ["SUPABASE_DB_PORT"] });

      expect(shell.get("SUPABASE_X")).toBe("1");
      expect(shell.get("SUPABASE_DB_PORT")).toBe("2");
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.orElse(
            ConfigProvider.fromEnvRecord({ SUPABASE_X: "1" }),
            ConfigProvider.fromEnvRecord({ SUPABASE_DB_PORT: "2" }),
          ),
        ),
      ),
    ),
  );

  it.effect("reads requested names from a lookup-only provider", () =>
    Effect.gen(function* () {
      const shell = yield* readShellEnvironment({ names: ["SUPABASE_DB_PORT"] });

      expect(Object.fromEntries(shell.entries())).toEqual({ SUPABASE_DB_PORT: "3" });
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.make((path) =>
            Effect.succeed(
              path.join("_") === "SUPABASE_DB_PORT" ? ConfigProvider.makeValue("3") : undefined,
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("sees a name added after the provider was built once it is loaded by name", () =>
    Effect.gen(function* () {
      const record: Record<string, string> = { SUPABASE_DB_PORT: "4" };
      const provider = ConfigProvider.fromEnvRecord(record);
      record["SUPABASE_API_PORT"] = "5";

      const shell = yield* readShellEnvironment({ names: ["SUPABASE_API_PORT"] }).pipe(
        Effect.provide(ConfigProvider.layer(provider)),
      );

      expect(shell.get("SUPABASE_API_PORT")).toBe("5");
    }),
  );

  it.effect("does not pay for sparse numeric name segments", () =>
    Effect.gen(function* () {
      let loads = 0;
      const inner = ConfigProvider.fromEnvRecord({ RUN_2000000: "x", SUPABASE_DB_PORT: "4" });
      const counting = ConfigProvider.make((path) =>
        Effect.suspend(() => {
          loads += 1;
          return inner.load(path);
        }),
      );

      const shell = yield* readShellEnvironment().pipe(
        Effect.provide(ConfigProvider.layer(counting)),
      );

      expect(shell.get("RUN_2000000")).toBeUndefined();
      expect(shell.get("SUPABASE_DB_PORT")).toBe("4");
      expect(loads).toBeLessThan(1000);
    }),
  );

  it.effect("finds a shell-only dotenvx key whose numeric suffix is past the walk cap", () =>
    Effect.gen(function* () {
      const shell = yield* readShellEnvironment({ highestNumericSuffixOf: ["DOTENV_PRIVATE_KEY"] });

      expect(shell.get("DOTENV_PRIVATE_KEY_2026")).toBe("k");
    }).pipe(Effect.provide(withShell({ DOTENV_PRIVATE_KEY_2026: "k" }))),
  );

  it.effect("loads each requested name once", () =>
    Effect.gen(function* () {
      let loads = 0;
      const provider = ConfigProvider.make((path) =>
        Effect.sync(() => {
          if (path.join("_") === "SUPABASE_ONCE") loads += 1;
          return path.join("_") === "SUPABASE_ONCE" ? ConfigProvider.makeValue("1") : undefined;
        }),
      );

      yield* Effect.gen(function* () {
        const shell = yield* readShellEnvironment();
        yield* shell.load(["SUPABASE_ONCE"]);
        yield* shell.load(["SUPABASE_ONCE"]);
      }).pipe(Effect.provide(ConfigProvider.layer(provider)));

      expect(loads).toBe(1);
    }),
  );
});

describe("project env loader", () => {
  const workdir = useTempWorkdir("supabase-cli-config-env-");

  const write = (relative: string, contents: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const target = path.join(workdir.current, relative);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, contents);
    });

  const fixtures: ReadonlyArray<{
    readonly name: string;
    readonly files: Readonly<Record<string, string>>;
    readonly shell: Readonly<Record<string, string>>;
    readonly expected: Readonly<Record<string, string>>;
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
      expected: { A: "dev-local", B: "local", C: "plain" },
    },
    {
      name: "supabase/ is read before the project root",
      files: { "supabase/.env": "A=nested", ".env": "A=root\nB=root" },
      shell: {},
      expected: { A: "nested", B: "root" },
    },
    {
      name: "SUPABASE_ENV selects the env-specific files",
      files: { "supabase/.env.staging": "A=staging", "supabase/.env.development": "A=dev" },
      shell: { SUPABASE_ENV: "staging" },
      expected: { A: "staging" },
    },
    {
      name: "the test env skips .env.local",
      files: { "supabase/.env.local": "A=local", "supabase/.env.test": "A=test" },
      shell: { SUPABASE_ENV: "test" },
      expected: { A: "test" },
    },
    {
      name: "an empty SUPABASE_ENV falls back to development",
      files: { "supabase/.env.development": "A=dev" },
      shell: { SUPABASE_ENV: "" },
      expected: { A: "dev" },
    },
    {
      name: "a shell variable shadows the files even when it is empty",
      files: { "supabase/.env": "A=file\nB=file\nC=file" },
      shell: { A: "shell", B: "" },
      expected: { C: "file" },
    },
    {
      name: "godotenv quoting and variable expansion",
      files: { "supabase/.env": 'BASE=one\nQUOTED="two words"\nCOMBINED="${BASE}-x"\nexport E=1' },
      shell: {},
      expected: { BASE: "one", QUOTED: "two words", COMBINED: "one-x", E: "1" },
    },
  ];

  for (const fixture of fixtures) {
    it.effect(`loads ${fixture.name}`, () =>
      Effect.gen(function* () {
        for (const [relative, contents] of Object.entries(fixture.files)) {
          yield* write(relative, contents);
        }

        const loaded = yield* loadCliProjectEnvFiles(workdir.current);

        expect(loaded.values).toEqual(fixture.expected);
        expect(Object.keys(loaded.files).sort()).toEqual(Object.keys(fixture.expected).sort());
      }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, withShell(fixture.shell)))),
    );
  }

  it.effect("records the file each value came from", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      yield* write("supabase/.env.local", "A=local");
      yield* write(".env", "B=root");

      const loaded = yield* loadCliProjectEnvFiles(workdir.current);

      expect(loaded.files).toEqual({
        A: path.join(workdir.current, "supabase", ".env.local"),
        B: path.join(workdir.current, ".env"),
      });
    }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, withShell({})))),
  );

  it.effect("lets a lookup-only shell variable shadow a file key the key trie cannot reveal", () =>
    Effect.gen(function* () {
      yield* write("supabase/.env", "A=file\nB=file");

      const loaded = yield* loadCliProjectEnvFiles(workdir.current);

      expect(loaded.values).toEqual({ B: "file" });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          ConfigProvider.layer(
            ConfigProvider.make((path) =>
              Effect.succeed(
                path.join("_") === "A" ? ConfigProvider.makeValue("shell") : undefined,
              ),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("fails with the file name when a file is unreadable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(workdir.current, "supabase", ".env"), { recursive: true });
      const unreadable = yield* Effect.flip(loadCliProjectEnvFiles(workdir.current));
      expect(unreadable.message).toBe("failed to read environment file: .env");
    }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, withShell({})))),
  );

  it.effect("fails with the file name on a malformed line", () =>
    Effect.gen(function* () {
      yield* write("supabase/.env.local", "not a valid line\n");

      const failure = yield* Effect.flip(loadCliProjectEnvFiles(workdir.current));

      expect(failure.message).toBe("failed to parse environment file: .env.local");
    }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, withShell({})))),
  );
});
