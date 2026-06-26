import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, Stream } from "effect";
import { badArgument } from "effect/PlatformError";

import {
  mockLegacyCliConfig,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput, mockStdin } from "../../../../../tests/helpers/mocks.ts";
import { Stdin } from "../../../../shared/runtime/stdin.service.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import { LegacyMigrationNewWriteError } from "./new.errors.ts";
import { legacyMigrationNew } from "./new.handler.ts";

interface SetupOpts {
  readonly format?: OutputFormat;
  readonly isTTY?: boolean;
  readonly piped?: string;
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockLegacyTelemetryStateTracked();
  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    mockStdin(opts.isTTY ?? true, opts.piped),
    mockLegacyCliConfig({ workdir }),
    BunServices.layer,
  );
  return { layer, out, telemetry };
}

// Strip ANSI so assertions are colour-independent (`legacyBold` emits colour on a TTY).
// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/gu, "");

const tmp = useLegacyTempWorkdir();

const migrationsDir = (workdir: string) => join(workdir, "supabase", "migrations");
const onlyMigration = (workdir: string) => {
  const files = readdirSync(migrationsDir(workdir));
  expect(files).toHaveLength(1);
  return files[0]!;
};

describe("legacy migration new", () => {
  it.live("creates a timestamped migration file and prints its relative path", () => {
    const { layer, out, telemetry } = setup(tmp.current);
    return Effect.gen(function* () {
      yield* legacyMigrationNew({ migrationName: "create_widgets" });

      const file = onlyMigration(tmp.current);
      expect(file).toMatch(/^\d{14}_create_widgets\.sql$/u);
      // Empty file when stdin is a TTY (Go writes nothing).
      expect(readFileSync(join(migrationsDir(tmp.current), file), "utf8")).toBe("");
      // Go prints the workdir-relative path, not the absolute write path.
      expect(stripAnsi(out.stdoutText)).toBe(
        `Created new migration at supabase/migrations/${file}\n`,
      );
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("writes piped stdin into the new migration verbatim", () => {
    const script = "create table pet;\ndrop table pet;\n";
    const { layer, out } = setup(tmp.current, { isTTY: false, piped: script });
    return Effect.gen(function* () {
      yield* legacyMigrationNew({ migrationName: "from_stdin" });

      const file = onlyMigration(tmp.current);
      // Byte-exact: the trailing newline is preserved (Go copies raw stdin bytes).
      expect(readFileSync(join(migrationsDir(tmp.current), file), "utf8")).toBe(script);
      expect(stripAnsi(out.stdoutText)).toContain(`Created new migration at supabase/migrations/`);
    }).pipe(Effect.provide(layer));
  });

  it.live("creates an empty migration when stdin is piped but empty", () => {
    const { layer } = setup(tmp.current, { isTTY: false });
    return Effect.gen(function* () {
      yield* legacyMigrationNew({ migrationName: "empty_pipe" });
      const file = onlyMigration(tmp.current);
      expect(readFileSync(join(migrationsDir(tmp.current), file), "utf8")).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a structured result with the absolute path in json", () => {
    const { layer, out } = setup(tmp.current, { format: "json" });
    return Effect.gen(function* () {
      yield* legacyMigrationNew({ migrationName: "as_json" });

      const file = onlyMigration(tmp.current);
      // No human text line in machine mode.
      expect(out.stdoutText).toBe("");
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Migration created",
          data: { path: join(migrationsDir(tmp.current), file) },
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a structured result in stream-json", () => {
    const { layer, out } = setup(tmp.current, { format: "stream-json" });
    return Effect.gen(function* () {
      yield* legacyMigrationNew({ migrationName: "as_stream" });
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "Migration created" }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("reports a write failure and still flushes telemetry", () => {
    // A file at <workdir>/supabase makes `makeDirectory(supabase/migrations)` fail.
    writeFileSync(join(tmp.current, "supabase"), "not a directory");
    const { layer, telemetry } = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationNew({ migrationName: "doomed" }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(LegacyMigrationNewWriteError);
        }
      }
      expect(existsSync(migrationsDir(tmp.current))).toBe(false);
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a name that escapes the migrations directory and writes nothing", () => {
    const { layer, telemetry } = setup(tmp.current, { isTTY: false, piped: "DROP DATABASE;\n" });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationNew({
        migrationName: "../../../escapes",
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(LegacyMigrationNewWriteError);
        }
      }
      // The guard fires before any directory/file is touched: nothing is created
      // under the workdir (not the migrations dir, not the escaped target).
      expect(existsSync(join(tmp.current, "supabase"))).toBe(false);
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "fails the command when piped stdin errors mid-copy (Go: failed to copy from stdin)",
    () => {
      // Go's io.Copy returns "failed to copy from stdin" and exits non-zero on a stdin read
      // error (new.go:42); the streaming copy must surface that, not leave a truncated file.
      const failingStdin = Layer.succeed(Stdin, {
        isTTY: false,
        readPipedBytes: Effect.succeed(Option.none()),
        pipedBytesStream: Stream.fail(badArgument({ module: "Stdin", method: "read" })),
        readPipedText: Effect.succeed(Option.none()),
        readLine: () => Effect.succeed(Option.none()),
      });
      const out = mockOutput();
      const telemetry = mockLegacyTelemetryStateTracked();
      const layer = Layer.mergeAll(
        out.layer,
        telemetry.layer,
        failingStdin,
        mockLegacyCliConfig({ workdir: tmp.current }),
        BunServices.layer,
      );
      return Effect.gen(function* () {
        const exit = yield* legacyMigrationNew({ migrationName: "stdin_boom" }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(failure)).toBe(true);
          if (Option.isSome(failure)) {
            expect(failure.value).toBeInstanceOf(LegacyMigrationNewWriteError);
            if (failure.value instanceof LegacyMigrationNewWriteError) {
              expect(failure.value.message).toContain("failed to copy from stdin");
            }
          }
        }
        expect(telemetry.flushed).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );
});
