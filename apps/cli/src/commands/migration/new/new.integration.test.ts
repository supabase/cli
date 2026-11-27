import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { badArgument } from "effect/PlatformError";

import { stripAnsi } from "../../../../tests/helpers/ansi.ts";
import { mockCommandSettings, useTempWorkdir } from "../../../../tests/helpers/command-mocks.ts";
import { mockStdin } from "../../../../tests/helpers/mocks.ts";
import { Stdin } from "../../../shared/runtime/stdin.service.ts";
import { CommandUX, ResolvedProject } from "../../../command-internal/command-executor.ts";
import { requireHostedMutationConsent } from "../../../command-internal/hosted-consent/hosted-consent.ts";
import { MigrationNewWriteError } from "./new.errors.ts";
import { migrationNew } from "./new.handler.ts";

interface SetupOpts {
  readonly isTTY?: boolean;
  readonly piped?: string;
  readonly openDoesNotMaterialize?: boolean;
  readonly writeDoesNotMaterialize?: boolean;
}

function nonMaterializingFsLayer(
  workdir: string,
  opts: Pick<SetupOpts, "openDoesNotMaterialize" | "writeDoesNotMaterialize">,
): Layer.Layer<FileSystem.FileSystem> {
  return Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const real = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return FileSystem.FileSystem.of({
        ...real,
        open: (filePath, options) =>
          opts.openDoesNotMaterialize === true
            ? real.open(path.join(workdir, ".deferred-open"), options)
            : real.open(filePath, options),
        writeFile: (filePath, data, options) =>
          opts.writeDoesNotMaterialize === true
            ? Effect.void
            : real.writeFile(filePath, data, options),
      });
    }),
  ).pipe(Layer.provide(BunServices.layer));
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const lines: string[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(CommandUX, {
      requireHostedMutationConsent,
      task: (_message, operation) => operation,
      writeToStderr: () => Effect.void,
      writeToStdout: (text) => Effect.sync(() => lines.push(`${text}\n`)),
    }),
    Layer.succeed(ResolvedProject, { record: () => Effect.void }),
    mockStdin(opts.isTTY ?? true, opts.piped),
    mockCommandSettings({ workdir }),
    BunServices.layer,
    ...(opts.openDoesNotMaterialize === true || opts.writeDoesNotMaterialize === true
      ? [nonMaterializingFsLayer(workdir, opts)]
      : []),
  );
  return { layer, lines };
}

const tmp = useTempWorkdir();

const migrationsDir = Effect.fnUntraced(function* (workdir: string) {
  const path = yield* Path.Path;
  return path.join(workdir, "supabase", "migrations");
});

const migrationPath = Effect.fnUntraced(function* (workdir: string, file: string) {
  const path = yield* Path.Path;
  return path.join(yield* migrationsDir(workdir), file);
});

const listMigrations = Effect.fnUntraced(function* (workdir: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readDirectory(yield* migrationsDir(workdir));
});

const onlyMigration = Effect.fnUntraced(function* (workdir: string) {
  const files = yield* listMigrations(workdir);
  expect(files).toHaveLength(1);
  return yield* Effect.fromNullishOr(files[0]);
});

const readMigration = Effect.fnUntraced(function* (workdir: string, file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(yield* migrationPath(workdir, file));
});

const pathExists = Effect.fnUntraced(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false));
});

const projectPath = Effect.fnUntraced(function* (workdir: string) {
  const path = yield* Path.Path;
  return path.join(workdir, "supabase");
});

describe("migration new", () => {
  it.effect("creates an empty timestamped migration and returns its absolute path", () => {
    const { layer } = setup(tmp.current);
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 10, 27, 12, 34, 56));
      const result = yield* migrationNew({ migrationName: "create_widgets" });

      const file = "20261127123456_create_widgets.sql";
      expect(yield* readMigration(tmp.current, file)).toBe("");
      expect(result).toEqual({
        output: { path: yield* migrationPath(tmp.current, file), message: "Migration created" },
        hookData: { displayPath: (yield* Path.Path).join("supabase", "migrations", file) },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes piped stdin into the new migration verbatim", () => {
    const script = "create table pet;\ndrop table pet;\n";
    const { layer } = setup(tmp.current, { isTTY: false, piped: script });
    return Effect.gen(function* () {
      yield* migrationNew({ migrationName: "from_stdin" });

      const file = yield* onlyMigration(tmp.current);
      expect(yield* readMigration(tmp.current, file)).toBe(script);
    }).pipe(Effect.provide(layer));
  });

  it.effect("creates an empty migration when stdin is piped but empty", () => {
    const { layer } = setup(tmp.current, { isTTY: false });
    return Effect.gen(function* () {
      yield* migrationNew({ migrationName: "empty_pipe" });
      const file = yield* onlyMigration(tmp.current);
      expect(yield* readMigration(tmp.current, file)).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.effect("materializes the migration without relying on an open handle", () => {
    const { layer } = setup(tmp.current, { openDoesNotMaterialize: true });
    return Effect.gen(function* () {
      yield* migrationNew({ migrationName: "windows_open" });
      const file = yield* onlyMigration(tmp.current);
      expect(yield* readMigration(tmp.current, file)).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not report success when the migration is not materialized", () => {
    const { layer, lines } = setup(tmp.current, {
      openDoesNotMaterialize: true,
      writeDoesNotMaterialize: true,
    });
    return Effect.gen(function* () {
      const error = yield* migrationNew({ migrationName: "missing" }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationNewWriteError);
      expect(error.message).toContain("failed to verify migration file");
      expect(yield* listMigrations(tmp.current)).toEqual([]);
      expect(lines).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a write failure without announcing a migration", () => {
    const { layer, lines } = setup(tmp.current);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // A file at <workdir>/supabase makes `makeDirectory(supabase/migrations)` fail.
      yield* fs.writeFileString(yield* projectPath(tmp.current), "not a directory");
      const error = yield* migrationNew({ migrationName: "doomed" }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationNewWriteError);
      expect(yield* pathExists(yield* migrationsDir(tmp.current))).toBe(false);
      expect(lines).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects a name that escapes the migrations directory and writes nothing", () => {
    const { layer } = setup(tmp.current, { isTTY: false, piped: "SELECT 1;\n" });
    return Effect.gen(function* () {
      const error = yield* migrationNew({ migrationName: "../../../escapes" }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationNewWriteError);
      expect(yield* pathExists(yield* projectPath(tmp.current))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "announces the partial migration before releasing the append handle on copy failure",
    () => {
      const { layer, lines } = setup(tmp.current);
      const failingStdin = Layer.succeed(Stdin, {
        isTTY: false,
        readPipedBytes: Effect.succeed(Option.none()),
        pipedBytesStream: Stream.make(new TextEncoder().encode("select 1;\n")).pipe(
          Stream.concat(Stream.fail(badArgument({ module: "Stdin", method: "read" }))),
        ),
        readPipedText: Effect.succeed(Option.none()),
        readLine: () => Effect.succeed(Option.none()),
      });
      const linesAtRelease: string[] = [];
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const error = yield* migrationNew({ migrationName: "stdin_boom" }).pipe(
          Effect.provide(failingStdin),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            open: (...args) =>
              Effect.gen(function* () {
                const handle = yield* fs.open(...args);
                const scope = yield* Scope.Scope;
                yield* Scope.addFinalizer(
                  scope,
                  Effect.sync(() => {
                    linesAtRelease.push(...lines);
                  }),
                );
                return handle;
              }),
          }),
          Effect.flip,
        );
        expect(error).toBeInstanceOf(MigrationNewWriteError);
        expect(error.message).toContain("failed to copy from stdin");
        const file = yield* onlyMigration(tmp.current);
        expect(yield* readMigration(tmp.current, file)).toBe("select 1;\n");
        expect(lines.map(stripAnsi)).toEqual([
          `Created new migration at supabase/migrations/${file}\n`,
        ]);
        expect(linesAtRelease).toEqual(lines);
      }).pipe(Effect.provide(layer));
    },
  );
});
