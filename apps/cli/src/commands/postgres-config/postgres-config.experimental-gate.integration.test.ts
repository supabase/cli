import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";

import { normalizeCause } from "../../shared/output/normalize-error.ts";
import { textCliOutputFormatter } from "../../shared/output/text-formatter.ts";
import { GLOBAL_FLAGS } from "../../command-internal/global-flags.ts";
import { mockOutput, mockTelemetryRuntime } from "../../../tests/helpers/mocks.ts";
import {
  buildTestRuntime,
  isolatedHomeLayer,
  mockCommandSettings,
  mockCommandPlatformApi,
  useTempWorkdir,
} from "../../../tests/helpers/command-mocks.ts";
import { postgresConfigCommand } from "./postgres-config.command.ts";

// Proves the --experimental gate is wired into the actual command pipeline (not just the
// shared helper in isolation), and that it runs before managementApiRuntimeLayer resolves an
// access token — wiring it any later would let a missing-token error mask the missing-flag error.

const tempRoot = useTempWorkdir("supabase-postgres-config-experimental-int-");

const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([postgresConfigCommand]),
  Command.withGlobalFlags(GLOBAL_FLAGS),
);

function setup() {
  const out = mockOutput({ format: "text" });
  const api = mockCommandPlatformApi({
    response: { status: 200, body: { max_connections: 100 } },
  });
  const runtime = buildTestRuntime({
    out,
    api,
    cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
    // The gate-open case builds the real managementApiRuntimeLayer inline, whose
    // cliSettings/credentials layers read real files under homeDir and ambient env — an
    // ambient access token, SUPABASE_EXPERIMENTAL, or keyring entry would make these
    // assertions non-deterministic.
    runtimeInfo: isolatedHomeLayer(tempRoot.current, { SUPABASE_NO_KEYRING: "1" }),
  });
  const layer = Layer.mergeAll(
    runtime,
    CliOutput.layer(textCliOutputFormatter()),
    mockTelemetryRuntime({
      configDir: `${tempRoot.current}/.supabase`,
      tracesDir: `${tempRoot.current}/.supabase/traces`,
    }),
  );
  return { layer, api };
}

describe("postgres-config experimental gate (Go PersistentPreRunE parity)", () => {
  const leaves: ReadonlyArray<{ readonly name: string; readonly args: ReadonlyArray<string> }> = [
    { name: "get", args: ["postgres-config", "get"] },
    { name: "update", args: ["postgres-config", "update"] },
    { name: "delete", args: ["postgres-config", "delete"] },
  ];

  for (const { name, args } of leaves) {
    it.live(`${name} fails with ExperimentalRequiredError when --experimental is unset`, () => {
      const { layer, api } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(Command.runWith(testRoot, { version: "0.0.0-test" })(args));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("ExperimentalRequiredError");
        }
        // A closed gate makes zero network requests, before even the eager token resolution.
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    });

    it.live(`${name} does not fail with the gate error once --experimental is set`, () => {
      const { layer, api } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Command.runWith(testRoot, { version: "0.0.0-test" })([...args, "--experimental"]),
        );
        // No real token is configured, so the command still fails — but past the gate,
        // at managementApiRuntimeLayer's auth resolution.
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const causeText = JSON.stringify(exit.cause);
          expect(causeText).not.toContain("ExperimentalRequiredError");
          expect(causeText).toContain("AccessTokenRequiredError");
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    });
  }

  // A malformed CSV value fails at parse time, before the experimental gate ever runs,
  // with pflag's own diagnostic text.
  const malformedCsvCases: ReadonlyArray<{
    readonly name: string;
    readonly args: ReadonlyArray<string>;
    readonly message: string;
  }> = [
    {
      name: "update",
      args: ["postgres-config", "update", "--config", 'a"b'],
      message:
        'invalid argument "a\\"b" for "--config" flag: parse error on line 1, column 2: bare " in non-quoted-field',
    },
    {
      name: "delete",
      args: ["postgres-config", "delete", "--config", '"max_connections'],
      // `"max_connections` is 16 bytes → EOF at column 17.
      message:
        'invalid argument "\\"max_connections" for "--config" flag: parse error on line 1, column 17: extraneous or missing " in quoted-field',
    },
  ];

  for (const { name, args, message } of malformedCsvCases) {
    it.live(
      `${name}: malformed --config CSV fails at parse time with pflag's exact diagnostic, before the gate`,
      () => {
        const { layer, api } = setup();
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            Command.runWith(testRoot, { version: "0.0.0-test" })(args),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).not.toContain("ExperimentalRequiredError");
            expect(normalizeCause(exit.cause).message).toBe(message);
          }
          expect(api.requests).toHaveLength(0);
        }).pipe(Effect.provide(layer));
      },
    );
  }
});
