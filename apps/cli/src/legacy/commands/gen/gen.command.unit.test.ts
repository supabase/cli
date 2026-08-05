import { Effect, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import { describe, expect, test } from "vitest";
import { LEGACY_GLOBAL_FLAGS } from "../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../shared/legacy/go-proxy.service.ts";
import { textCliOutputFormatter } from "../../../shared/output/text-formatter.ts";
import { legacyGenCommand } from "./gen.command.ts";

const legacyTestRoot = Command.make("supabase").pipe(
  Command.withGlobalFlags(LEGACY_GLOBAL_FLAGS),
  Command.withSubcommands([legacyGenCommand]),
);

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

describe("legacy `gen keys` (CLI-1964)", () => {
  // Go deprecates `gen keys` in favor of `gen signing-key`
  // (`Deprecated: use "gen signing-key" instead.`, `apps/cli-go/cmd/gen.go`).
  // `gen signing-key` is already natively ported, and the workflow `gen keys`
  // served (HS256 preview-branch keys against a decommissioned Fly host) no
  // longer exists, so the proxy was dropped entirely rather than kept or
  // reimplemented — see docs/go-cli-porting-status.md.
  test("gen keys no longer routes to a hidden proxy", async () => {
    const proxy = mockLegacyGoProxy();

    const exit = await Effect.runPromise(
      Command.runWith(legacyTestRoot, { version: "0.0.0-test" })(["gen", "keys"]).pipe(
        Effect.provide(Layer.mergeAll(proxy.layer, CliOutput.layer(textCliOutputFormatter()))),
        Effect.exit,
      ) as Effect.Effect<unknown, never, never>,
    );

    expect(JSON.stringify(exit)).toContain(
      String.raw`"_tag":"UnknownSubcommand","subcommand":"keys","parent":["supabase","gen"]`,
    );
    expect(proxy.calls).toEqual([]);
  });
});
