import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { LegacyCredentials } from "../../auth/legacy-credentials.service.ts";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { LegacyLinkedProjectCache } from "../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyOutputFlag } from "../../../shared/legacy/global-flags.ts";
import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import { mockLegacyTelemetryStateTracked } from "../../../../tests/helpers/legacy-mocks.ts";
import { legacyServices } from "./services.handler.ts";

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
      expect(rows[0]).toMatchObject({ name: "supabase/postgres", local: "17.6.1.132" });
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
          expect.objectContaining({ name: "supabase/postgres", local: "17.6.1.132" }),
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
          expect.objectContaining({ name: "supabase/postgres", local: "17.6.1.132" }),
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
      expect(out.stdoutText).toContain("local: 17.6.1.132");
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
