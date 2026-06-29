import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { textCliOutputFormatter } from "../../../../shared/output/text-formatter.ts";
import { legacyDbResetCommand } from "./reset.command.ts";
import { legacyDbReset } from "./reset.handler.ts";
import type { LegacyDbResetFlags } from "./reset.command.ts";

function setupLegacyDbReset() {
  const calls: Array<ReadonlyArray<string>> = [];
  const layer = Layer.succeed(LegacyGoProxy, {
    exec: (args) =>
      Effect.sync(() => {
        calls.push(args);
      }),
    execCapture: () => Effect.succeed(""),
  });
  return { layer, calls };
}

const baseFlags: LegacyDbResetFlags = {
  dbUrl: Option.none(),
  linked: false,
  local: false,
  noSeed: false,
  sqlPaths: [],
  version: Option.none(),
  last: Option.none(),
};

describe("legacy db reset", () => {
  it.live("forwards the empty-array baseline without seed override flags", () => {
    const { layer, calls } = setupLegacyDbReset();
    return Effect.gen(function* () {
      yield* legacyDbReset(baseFlags);
      expect(calls).toEqual([["db", "reset"]]);
    }).pipe(Effect.provide(layer));
  });

  it.live("forwards --no-seed alone", () => {
    const { layer, calls } = setupLegacyDbReset();
    return Effect.gen(function* () {
      yield* legacyDbReset({ ...baseFlags, noSeed: true });
      expect(calls).toEqual([["db", "reset", "--no-seed"]]);
    }).pipe(Effect.provide(layer));
  });

  it.live("forwards a single --sql-paths flag", () => {
    const { layer, calls } = setupLegacyDbReset();
    return Effect.gen(function* () {
      yield* legacyDbReset({
        ...baseFlags,
        sqlPaths: ["./seeds/base.sql"],
      });
      expect(calls).toEqual([["db", "reset", "--sql-paths", "./seeds/base.sql"]]);
    }).pipe(Effect.provide(layer));
  });

  it.live("forwards repeated --sql-paths flags in order", () => {
    const { layer, calls } = setupLegacyDbReset();
    return Effect.gen(function* () {
      yield* legacyDbReset({
        ...baseFlags,
        sqlPaths: ["./seeds/base.sql", "./seeds/demo/*.sql"],
      });
      expect(calls).toEqual([
        ["db", "reset", "--sql-paths", "./seeds/base.sql", "--sql-paths", "./seeds/demo/*.sql"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("forwards --no-seed with --sql-paths so Go owns the diagnostic", () => {
    const { layer, calls } = setupLegacyDbReset();
    return Effect.gen(function* () {
      yield* legacyDbReset({
        ...baseFlags,
        noSeed: true,
        sqlPaths: ["./seeds/base.sql"],
      });
      expect(calls).toEqual([["db", "reset", "--no-seed", "--sql-paths", "./seeds/base.sql"]]);
    }).pipe(Effect.provide(layer));
  });

  it.live("forwards an empty --sql-paths value so Go owns the diagnostic", () => {
    const { layer, calls } = setupLegacyDbReset();
    return Effect.gen(function* () {
      yield* legacyDbReset({
        ...baseFlags,
        sqlPaths: [""],
      });
      expect(calls).toEqual([["db", "reset", "--sql-paths", ""]]);
    }).pipe(Effect.provide(layer));
  });

  it("parses repeated --sql-paths flags from the command surface", async () => {
    const { layer, calls } = setupLegacyDbReset();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Command.runWith(legacyDbResetCommand, { version: "0.0.0-test" })([
            "--sql-paths",
            "./seeds/base.sql",
            "--sql-paths",
            "./seeds/demo/*.sql",
          ]);
          expect(calls).toEqual([
            ["db", "reset", "--sql-paths", "./seeds/base.sql", "--sql-paths", "./seeds/demo/*.sql"],
          ]);
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            layer,
            mockOutput({ format: "text" }).layer,
            CliOutput.layer(textCliOutputFormatter()),
          ),
        ),
      ) as Effect.Effect<void>,
    );
  });

  it("forwards mutually exclusive seed flags from the command surface", async () => {
    const { layer, calls } = setupLegacyDbReset();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Command.runWith(legacyDbResetCommand, { version: "0.0.0-test" })([
            "--no-seed",
            "--sql-paths",
            "./seeds/base.sql",
          ]);
          expect(calls).toEqual([["db", "reset", "--no-seed", "--sql-paths", "./seeds/base.sql"]]);
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            layer,
            mockOutput({ format: "text" }).layer,
            CliOutput.layer(textCliOutputFormatter()),
          ),
        ),
      ) as Effect.Effect<void>,
    );
  });
});
