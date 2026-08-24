import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Schema } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";

import { normalizeCause } from "../../../shared/output/normalize-error.ts";
import { textCliOutputFormatter } from "../../../shared/output/text-formatter.ts";
import { LEGACY_GLOBAL_FLAGS } from "../../../shared/legacy/global-flags.ts";
import { mockOutput, mockTelemetryRuntime } from "../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  legacyIsolatedHomeLayer,
  mockLegacyCliConfig,
  mockLegacyPlatformApi,
  useLegacyTempWorkdir,
} from "../../../../tests/helpers/legacy-mocks.ts";
import { legacyPostgresConfigCommand } from "./postgres-config.command.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

// This suite proves the `--experimental` gate is wired into the actual
// `.command.ts` handler pipeline (not just the shared helper in isolation),
// and — critically — that it runs BEFORE `legacyManagementApiRuntimeLayer`
// resolves an access token. The root `PersistentPreRunE` checks
// `IsExperimental` before the `IsManagementAPI` login check
// (`apps/cli-go/cmd/root.go:91-109`); `legacyManagementApiRuntimeLayer`
// eagerly fails on a missing token as part of its own layer construction, so
// wiring the gate anywhere except immediately before that layer is attached
// would let a missing-token error mask the missing-`--experimental` error.

const tempRoot = useLegacyTempWorkdir("supabase-postgres-config-experimental-int-");

const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([legacyPostgresConfigCommand]),
  Command.withGlobalFlags(LEGACY_GLOBAL_FLAGS),
);

function setup() {
  const out = mockOutput({ format: "text" });
  const api = mockLegacyPlatformApi({
    response: { status: 200, body: { max_connections: 100 } },
  });
  const runtime = buildLegacyTestRuntime({
    out,
    api,
    cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
    // The "gate open" case builds the real `legacyManagementApiRuntimeLayer`
    // inline inside the command; its cliConfig/credentials layers read real
    // files under homeDir and ambient env — an ambient SUPABASE_ACCESS_TOKEN,
    // SUPABASE_EXPERIMENTAL, or OS keyring entry on the machine running the
    // test would make these assertions non-deterministic. Isolate both, keeping
    // only the keyring kill-switch set.
    runtimeInfo: legacyIsolatedHomeLayer(tempRoot.current, { SUPABASE_NO_KEYRING: "1" }),
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

describe("legacy postgres-config experimental gate (Go PersistentPreRunE parity)", () => {
  const leaves: ReadonlyArray<{ readonly name: string; readonly args: ReadonlyArray<string> }> = [
    { name: "get", args: ["postgres-config", "get"] },
    { name: "update", args: ["postgres-config", "update"] },
    { name: "delete", args: ["postgres-config", "delete"] },
  ];

  for (const { name, args } of leaves) {
    it.live(
      `${name} fails with LegacyExperimentalRequiredError when --experimental is unset`,
      () => {
        const { layer, api } = setup();
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            Command.runWith(testRoot, { version: "0.0.0-test" })(args),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(encodeJson(exit.cause)).toContain("LegacyExperimentalRequiredError");
          }
          // The gate must run before any API call (and before the eager
          // access-token resolution inside `legacyManagementApiRuntimeLayer`) —
          // a closed gate makes zero network requests.
          expect(api.requests).toHaveLength(0);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(`${name} does not fail with the gate error once --experimental is set`, () => {
      const { layer, api } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Command.runWith(testRoot, { version: "0.0.0-test" })([...args, "--experimental"]),
        );
        // No real access token is configured in this test environment, so the
        // command still fails — but past the gate, at the auth-resolution step
        // that `legacyManagementApiRuntimeLayer` performs, never with the
        // experimental gate error once the flag is on.
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const causeText = encodeJson(exit.cause);
          expect(causeText).not.toContain("LegacyExperimentalRequiredError");
          expect(causeText).toContain("LegacyPlatformAuthRequiredError");
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    });
  }

  // pflag's `readAsCSV` error aborts cobra's `ParseFlags` BEFORE
  // `PersistentPreRunE`'s experimental-gate check, so the parse error must
  // win even with `--experimental` unset. The rendered line matches pflag's
  // own diagnostic (pflag v1.0.10 `errors.go:116` wrapping `encoding/csv`) —
  // same prior art as network-bans/network-restrictions.
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
            expect(encodeJson(exit.cause)).not.toContain("LegacyExperimentalRequiredError");
            expect(normalizeCause(exit.cause).message).toBe(message);
          }
          expect(api.requests).toHaveLength(0);
        }).pipe(Effect.provide(layer));
      },
    );
  }
});
