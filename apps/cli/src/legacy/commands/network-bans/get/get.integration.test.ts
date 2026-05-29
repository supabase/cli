import { type V1ListAllNetworkBansOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { legacyNetworkBansGet } from "./get.handler.ts";

const SAMPLE_BANS: typeof V1ListAllNetworkBansOutput.Type = {
  banned_ipv4_addresses: ["192.168.0.1", "192.168.0.2"],
};

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  legacyOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  response?: typeof V1ListAllNetworkBansOutput.Type;
  status?: number;
  network?: "fail";
}

const tempRoot = useLegacyTempWorkdir("supabase-network-bans-get-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 201, body: opts.response ?? SAMPLE_BANS },
    network: opts.network,
  });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    goOutput: opts.legacyOutput === undefined ? Option.none() : Option.some(opts.legacyOutput),
  });
  return { layer, out, api };
}

function setupTracked(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 201, body: opts.response ?? SAMPLE_BANS },
    network: opts.network,
  });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    telemetry: telemetry.layer,
    linkedProjectCache: cache.layer,
  });
  return { layer, out, api, telemetry, cache };
}

describe("legacy network-bans get integration", () => {
  it.live("writes the stderr heading and JSON array bytes in text mode", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyNetworkBansGet({ projectRef: Option.none() });
      expect(out.stderrText).toBe("DB banned IPs:\n");
      expect(out.stdoutText).toBe(
        `[
  "192.168.0.1",
  "192.168.0.2"
]
`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("emits TOML bytes for --output toml", () => {
    const { layer, out } = setup({ legacyOutput: "toml" });
    return Effect.gen(function* () {
      yield* legacyNetworkBansGet({ projectRef: Option.none() });
      expect(out.stderrText).toBe("DB banned IPs:\n");
      expect(out.stdoutText).toBe('banned_ips = ["192.168.0.1", "192.168.0.2"]\n');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits YAML bytes for --output yaml", () => {
    const { layer, out } = setup({ legacyOutput: "yaml" });
    return Effect.gen(function* () {
      yield* legacyNetworkBansGet({ projectRef: Option.none() });
      expect(out.stderrText).toBe("DB banned IPs:\n");
      expect(out.stdoutText).toContain("192.168.0.1");
      expect(out.stdoutText).toContain("192.168.0.2");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-compatible JSON bytes for --output json", () => {
    const { layer, out } = setup({ legacyOutput: "json" });
    return Effect.gen(function* () {
      yield* legacyNetworkBansGet({ projectRef: Option.none() });
      expect(out.stderrText).toBe("DB banned IPs:\n");
      expect(out.stdoutText).toBe(
        `[
  "192.168.0.1",
  "192.168.0.2"
]
`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("treats --output pretty as a JSON alias matching Go's get.go switch", () => {
    const { layer, out } = setup({ legacyOutput: "pretty" });
    return Effect.gen(function* () {
      yield* legacyNetworkBansGet({ projectRef: Option.none() });
      expect(out.stderrText).toBe("DB banned IPs:\n");
      expect(out.stdoutText).toBe(
        `[
  "192.168.0.1",
  "192.168.0.2"
]
`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with the env-not-supported error for --output env", () => {
    const { layer, out } = setup({ legacyOutput: "env" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyNetworkBansGet({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.stderrText).toBe("DB banned IPs:\n");
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacyNetworkBansEnvNotSupportedError");
        expect(errJson).toContain("--output env flag is not supported");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a structured JSON success payload via --output-format=json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyNetworkBansGet({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({
        banned_ipv4_addresses: ["192.168.0.1", "192.168.0.2"],
      });
      // TS-native machine-readable modes skip the stderr heading.
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a result event via --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* legacyNetworkBansGet({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({
        banned_ipv4_addresses: ["192.168.0.1", "192.168.0.2"],
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output wins over TS --output-format when both are set", () => {
    const { layer, out } = setup({ format: "json", legacyOutput: "toml" });
    return Effect.gen(function* () {
      yield* legacyNetworkBansGet({ projectRef: Option.none() });
      expect(out.stderrText).toBe("DB banned IPs:\n");
      expect(out.stdoutText).toBe('banned_ips = ["192.168.0.1", "192.168.0.2"]\n');
    }).pipe(Effect.provide(layer));
  });

  it.live("posts to the /network-bans/retrieve endpoint with the resolved ref", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyNetworkBansGet({ projectRef: Option.none() });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.method).toBe("POST");
      expect(api.requests[0]?.url).toContain(
        `/v1/projects/${LEGACY_VALID_REF}/network-bans/retrieve`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("uses --project-ref flag value over LegacyCliConfig.projectId", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyNetworkBansGet({ projectRef: Option.some(flagRef) });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${flagRef}/`);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyNetworkBansGetUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyNetworkBansGet({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacyNetworkBansGetUnexpectedStatusError");
        expect(errJson).toContain("unexpected list bans status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("reports a network error when the API transport fails", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyNetworkBansGet({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacyNetworkBansGetNetworkError");
        expect(errJson).toContain("failed to list network bans:");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a fail event when withJsonErrorHandling wraps a JSON-mode error", () => {
    const { layer, out } = setup({ format: "json", status: 503 });
    return Effect.gen(function* () {
      yield* legacyNetworkBansGet({ projectRef: Option.none() }).pipe(withJsonErrorHandling);
      expect(out.messages.some((m) => m.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry and writes linked-project cache on success", () => {
    const { layer, telemetry, cache } = setupTracked();
    return Effect.gen(function* () {
      yield* legacyNetworkBansGet({ projectRef: Option.none() });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry even on API failure", () => {
    const { layer, telemetry, cache } = setupTracked({ status: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyNetworkBansGet({ projectRef: Option.none() }).pipe(Effect.provide(layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(telemetry.flushed).toBe(true);
      // Linked-project cache wraps the inner effect, so it still fires after ref
      // resolution succeeded — matches Go's PersistentPostRun once ref is known.
      expect(cache.cached).toBe(true);
    });
  });
});
