import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";

import { textCliOutputFormatter } from "../../../shared/output/text-formatter.ts";
import { LegacyGoProxy } from "../../../shared/legacy/go-proxy.service.ts";
import { legacyMigrationCommand } from "./migration.command.ts";

function mockLegacyGoProxy() {
  const calls: Array<ReadonlyArray<string>> = [];
  const layer = Layer.succeed(LegacyGoProxy, {
    exec: (args) =>
      Effect.sync(() => {
        calls.push([...args]);
      }),
    execCapture: () => Effect.succeed(""),
  });

  return { layer, calls };
}

const legacyTestRoot = Command.make("supabase").pipe(
  Command.withSubcommands([legacyMigrationCommand]),
);

describe("legacy migration command integration", () => {
  it.live("accepts the Go-compatible plural migrations alias", () => {
    const proxy = mockLegacyGoProxy();
    const run = Effect.gen(function* () {
      yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })([
        "migrations",
        "new",
        "create_widgets",
      ]);

      expect(proxy.calls).toEqual([["migration", "new", "create_widgets"]]);
    }).pipe(Effect.provide(Layer.mergeAll(proxy.layer, CliOutput.layer(textCliOutputFormatter()))));

    // Command.runWith's Environment type is retained even though this path only needs CliOutput
    // and the mocked proxy at runtime.
    return run as Effect.Effect<void>;
  });
});
