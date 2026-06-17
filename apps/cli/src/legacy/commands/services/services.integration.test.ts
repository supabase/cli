import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { CliOutput, Command } from "effect/unstable/cli";
import { Stdio } from "effect";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { LegacyCredentials } from "../../auth/legacy-credentials.service.ts";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { LegacyLinkedProjectCache } from "../../telemetry/legacy-linked-project-cache.service.ts";
import { LEGACY_GLOBAL_FLAGS, LegacyOutputFlag } from "../../../shared/legacy/global-flags.ts";
import {
  mockAnalytics,
  mockOutput,
  mockRuntimeInfo,
  mockTty,
  processEnvLayer,
} from "../../../../tests/helpers/mocks.ts";
import { mockLegacyTelemetryStateTracked } from "../../../../tests/helpers/legacy-mocks.ts";
import { listLocalServiceVersions } from "../../../shared/services/services.shared.ts";
import { textCliOutputFormatter } from "../../../shared/output/text-formatter.ts";
import { processControlLayer } from "../../../shared/runtime/process-control.layer.ts";
import { TelemetryRuntime } from "../../../shared/telemetry/runtime.service.ts";
import { legacyServicesCommand } from "./services.command.ts";
import { legacyServices } from "./services.handler.ts";

const LOCAL_POSTGRES_SERVICE = listLocalServiceVersions().find(
  (service) => service.name === "supabase/postgres",
);

if (LOCAL_POSTGRES_SERVICE === undefined) {
  throw new Error("Missing supabase/postgres in local service versions.");
}

const LOCAL_POSTGRES_VERSION = LOCAL_POSTGRES_SERVICE.local;

function setup(
  opts: {
    format?: "text" | "json" | "stream-json";
    goOutput?: Option.Option<"env" | "pretty" | "json" | "toml" | "yaml">;
  } = {},
) {
  const out = mockOutput({
    format: opts.format ?? "text",
    interactive: (opts.format ?? "text") === "text",
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cachedRefs: string[] = [];

  return {
    out,
    telemetry,
    cachedRefs,
    layer: Layer.mergeAll(
      BunServices.layer,
      FetchHttpClient.layer,
      out.layer,
      telemetry.layer,
      Layer.succeed(LegacyOutputFlag, opts.goOutput ?? Option.none()),
      Layer.succeed(
        LegacyCliConfig,
        LegacyCliConfig.of({
          profile: "supabase",
          apiUrl: "https://api.supabase.com",
          projectHost: "supabase.co",
          poolerHost: "supabase.com",
          accessToken: Option.none(),
          projectId: Option.none(),
          workdir: process.cwd(),
          userAgent: "SupabaseCLI/test",
        }),
      ),
      Layer.succeed(LegacyCredentials, LegacyCredentials.of(legacyCredentialsMock)),
      Layer.succeed(
        LegacyLinkedProjectCache,
        LegacyLinkedProjectCache.of({
          cache: (ref) =>
            Effect.sync(() => {
              cachedRefs.push(ref);
            }),
        }),
      ),
    ),
  };
}

const legacyCredentialsMock = {
  getAccessToken: Effect.succeed(Option.none()),
  saveAccessToken: () => Effect.die("unexpected saveAccessToken"),
  deleteAccessToken: Effect.die("unexpected deleteAccessToken"),
  deleteAllProjectCredentials: Effect.void,
  deleteProjectCredential: () => Effect.succeed(false),
};

const legacyTestRoot = Command.make("supabase").pipe(
  Command.withGlobalFlags(LEGACY_GLOBAL_FLAGS),
  Command.withSubcommands([legacyServicesCommand]),
);

function expectFailureTag(exit: Exit.Exit<unknown, unknown>, tag: string) {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) {
    return;
  }

  const failure = Cause.findErrorOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (Option.isSome(failure)) {
    expect((failure.value as { _tag: string })._tag).toBe(tag);
  }
}

describe("legacy services", () => {
  it.effect("runs tokenless local service listing through command wiring", () =>
    Effect.tryPromise({
      try: async () => {
        const workdir = mkdtempSync(join(tmpdir(), "supabase-services-"));
        const out = mockOutput({ format: "text", interactive: false });
        const analytics = mockAnalytics();
        const args = ["services"];
        const layer = Layer.mergeAll(
          BunServices.layer,
          processControlLayer,
          CliOutput.layer(textCliOutputFormatter()),
          out.layer,
          analytics.layer,
          processEnvLayer({ SUPABASE_HOME: workdir }),
          mockRuntimeInfo({ cwd: workdir, homeDir: workdir }),
          mockTty({ stdinIsTty: false, stdoutIsTty: false }),
          Stdio.layerTest({ args: Effect.succeed(args) }),
          Layer.succeed(
            TelemetryRuntime,
            TelemetryRuntime.of({
              configDir: join(workdir, ".supabase"),
              tracesDir: join(workdir, ".supabase", "traces"),
              consent: "granted",
              showDebug: false,
              deviceId: "test-device-id",
              sessionId: "test-session-id",
              distinctId: undefined,
              isFirstRun: false,
              isTty: false,
              isCi: false,
              os: "linux",
              arch: "x64",
              cliVersion: "0.1.0",
            }),
          ),
        );

        await Effect.runPromise(
          Command.runWith(legacyTestRoot, { version: "0.0.0-test" })(args).pipe(
            Effect.provide(layer),
          ) as Effect.Effect<void>,
        );

        expect(out.stdoutText).toContain("supabase/postgres");
        expect(out.stdoutText).toContain("supabase/gotrue");
        expect(out.stderrText).not.toContain("Access token not provided");
      },
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  );

  it.live("prints the services table by default", () => {
    const { layer, out } = setup();

    return Effect.gen(function* () {
      yield* legacyServices({}).pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain("supabase/postgres");
      expect(out.stdoutText).toContain("supabase/gotrue");
      expect(out.stdoutText).toContain("supabase/storage-api");
      expect(out.stderrText).toBe("");
    });
  });

  it.live("emits a services JSON array for --output json", () => {
    const { layer, out } = setup({ goOutput: Option.some("json") });

    return Effect.gen(function* () {
      yield* legacyServices({}).pipe(Effect.provide(layer));

      const rows = JSON.parse(out.stdoutText) as Array<{
        name: string;
        local: string;
        remote: string;
      }>;
      expect(rows).toHaveLength(10);
      expect(rows[0]).toMatchObject({
        name: "supabase/postgres",
        local: LOCAL_POSTGRES_VERSION,
      });
    });
  });

  it.live("emits structured JSON for --output pretty combined with --output-format json", () => {
    // Regression guard (CLI-1546): a Go `--output pretty` must defer to the TS
    // `--output-format json` flag instead of forcing the human-readable table.
    const { layer, out } = setup({ format: "json", goOutput: Option.some("pretty") });

    return Effect.gen(function* () {
      yield* legacyServices({}).pipe(Effect.provide(layer));

      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toMatchObject({
        services: expect.arrayContaining([
          expect.objectContaining({
            name: "supabase/postgres",
            local: LOCAL_POSTGRES_VERSION,
          }),
        ]),
      });
    });
  });

  it.live("emits structured JSON for --output-format stream-json", () => {
    const { layer, out } = setup({ format: "stream-json" });

    return Effect.gen(function* () {
      yield* legacyServices({}).pipe(Effect.provide(layer));

      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toMatchObject({
        services: expect.arrayContaining([
          expect.objectContaining({
            name: "supabase/postgres",
            local: LOCAL_POSTGRES_VERSION,
          }),
        ]),
      });
    });
  });

  it.live("emits a TOML services array for --output toml", () => {
    const { layer, out } = setup({ goOutput: Option.some("toml") });

    return Effect.gen(function* () {
      yield* legacyServices({}).pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain("[[services]]");
      expect(out.stdoutText).toContain('name = "supabase/postgres"');
    });
  });

  it.live("emits a YAML services array for --output yaml", () => {
    const { layer, out } = setup({ goOutput: Option.some("yaml") });

    return Effect.gen(function* () {
      yield* legacyServices({}).pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain("- name: supabase/postgres");
      expect(out.stdoutText).toContain(`local: ${LOCAL_POSTGRES_VERSION}`);
    });
  });

  it.live("rejects --output env", () => {
    const { layer } = setup({ goOutput: Option.some("env") });

    return Effect.gen(function* () {
      const exit = yield* legacyServices({}).pipe(Effect.provide(layer), Effect.exit);
      expectFailureTag(exit, "LegacyServicesEnvNotSupportedError");
    });
  });

  it.live("flushes telemetry state after the command finishes", () => {
    const { layer, telemetry } = setup();

    return Effect.gen(function* () {
      yield* legacyServices({}).pipe(Effect.provide(layer));
      expect(telemetry.flushed).toBe(true);
    });
  });
});
