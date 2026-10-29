import { type V1ListAllNetworkBansOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Schema } from "effect";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { mockOutput, mockTty } from "../../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  buildTestRuntime,
  jsonResponse,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  useTempWorkdir,
  unverifiedTargetBanner,
} from "../../../../tests/helpers/command-mocks.ts";
import { describeHostedTargetSelection } from "../../../../tests/helpers/hosted-target-selection.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import {
  projectResponse,
  realLinkedProjectCache,
} from "../../../../tests/helpers/permission-real-layers.ts";
import { networkBansGet } from "./get.handler.ts";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const SAMPLE_BANS: typeof V1ListAllNetworkBansOutput.Type = {
  banned_ipv4_addresses: ["192.168.0.1", "192.168.0.2"],
};

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  outputFlag?: "env" | "pretty" | "json" | "toml" | "yaml";
  response?: typeof V1ListAllNetworkBansOutput.Type;
  status?: number;
  network?: "fail";
}

const tempRoot = useTempWorkdir("supabase-network-bans-get-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockCommandPlatformApi({
    response: { status: opts.status ?? 201, body: opts.response ?? SAMPLE_BANS },
    network: opts.network,
  });
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const layer = buildTestRuntime({
    out,
    api,
    cliSettings,
    outputFlag: opts.outputFlag === undefined ? Option.none() : Option.some(opts.outputFlag),
  });
  return { layer, out, api };
}

function setupTracked(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockCommandPlatformApi({
    response: { status: opts.status ?? 201, body: opts.response ?? SAMPLE_BANS },
    network: opts.network,
  });
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
  const layer = buildTestRuntime({
    out,
    api,
    cliSettings,
    telemetry: telemetry.layer,
    linkedProjectCache: cache.layer,
  });
  return { layer, out, api, telemetry, cache };
}

describe("network-bans get integration", () => {
  it.effect("writes the stderr heading and JSON array bytes in text mode", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* networkBansGet({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stderrText).toBe(unverifiedTargetBanner() + "DB banned IPs:\n");
      expect(out.stdoutText).toBe(
        `[
  "192.168.0.1",
  "192.168.0.2"
]
`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits TOML bytes for --output toml", () => {
    const { layer, out } = setup({ outputFlag: "toml" });
    return Effect.gen(function* () {
      yield* networkBansGet({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stderrText).toBe(unverifiedTargetBanner() + "DB banned IPs:\n");
      expect(out.stdoutText).toBe('banned_ips = ["192.168.0.1", "192.168.0.2"]\n');
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits YAML bytes for --output yaml", () => {
    const { layer, out } = setup({ outputFlag: "yaml" });
    return Effect.gen(function* () {
      yield* networkBansGet({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stderrText).toBe(unverifiedTargetBanner() + "DB banned IPs:\n");
      expect(out.stdoutText).toContain("192.168.0.1");
      expect(out.stdoutText).toContain("192.168.0.2");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits JSON bytes for --output json", () => {
    const { layer, out } = setup({ outputFlag: "json" });
    return Effect.gen(function* () {
      yield* networkBansGet({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stderrText).toBe(unverifiedTargetBanner() + "DB banned IPs:\n");
      expect(out.stdoutText).toBe(
        `[
  "192.168.0.1",
  "192.168.0.2"
]
`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("treats --output pretty as a JSON alias", () => {
    const { layer, out } = setup({ outputFlag: "pretty" });
    return Effect.gen(function* () {
      yield* networkBansGet({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stderrText).toBe(unverifiedTargetBanner() + "DB banned IPs:\n");
      expect(out.stdoutText).toBe(
        `[
  "192.168.0.1",
  "192.168.0.2"
]
`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with the env-not-supported error for --output env", () => {
    const { layer, out } = setup({ outputFlag: "env" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        networkBansGet({ remote: Option.none(), projectRef: Option.none() }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.stderrText).toBe(unverifiedTargetBanner() + "DB banned IPs:\n");
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("NetworkBansEnvNotSupportedError");
        expect(causeText).toContain("--output env flag is not supported");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a structured JSON success payload via --output-format=json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* networkBansGet({ remote: Option.none(), projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({
        banned_ipv4_addresses: ["192.168.0.1", "192.168.0.2"],
      });
      // TS-native machine-readable modes skip the stderr heading.
      expect(out.stderrText).toBe(unverifiedTargetBanner());
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a result event via --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* networkBansGet({ remote: Option.none(), projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({
        banned_ipv4_addresses: ["192.168.0.1", "192.168.0.2"],
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("--output wins over --output-format when both are set", () => {
    const { layer, out } = setup({ format: "json", outputFlag: "toml" });
    return Effect.gen(function* () {
      yield* networkBansGet({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stderrText).toBe(unverifiedTargetBanner() + "DB banned IPs:\n");
      expect(out.stdoutText).toBe('banned_ips = ["192.168.0.1", "192.168.0.2"]\n');
    }).pipe(Effect.provide(layer));
  });

  it.effect("posts to the /network-bans/retrieve endpoint with the resolved ref", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* networkBansGet({ remote: Option.none(), projectRef: Option.none() });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.method).toBe("POST");
      expect(api.requests[0]?.url).toContain(`/v1/projects/${VALID_REF}/network-bans/retrieve`);
      assertPermissionDrift({ command: "network-bans get", requests: api.requests, exact: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists the picker's projects, the bans and fills the real linked-project cache", () => {
    const out = mockOutput({ promptSelectResponses: [VALID_REF] });
    const api = mockCommandPlatformApi({
      handler: (request) => {
        if (request.url === "https://api.supabase.com/v1/projects") {
          return Effect.succeed(jsonResponse(request, 200, [projectResponse(VALID_REF)]));
        }
        if (request.url === `https://api.supabase.com/v1/projects/${VALID_REF}`) {
          return Effect.succeed(jsonResponse(request, 200, projectResponse(VALID_REF)));
        }
        return Effect.succeed(jsonResponse(request, 201, SAMPLE_BANS));
      },
    });
    const cliSettings = mockCommandSettings({
      workdir: tempRoot.current,
      projectId: Option.none(),
    });
    const layer = buildTestRuntime({
      out,
      api,
      cliSettings,
      tty: mockTty({ stdinIsTty: true }),
      linkedProjectCache: realLinkedProjectCache({
        httpClient: api.httpClientLayer,
        cliSettings,
      }),
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cachePath = `${tempRoot.current}/supabase/.temp/linked-project.json`;
      expect(yield* fs.exists(cachePath)).toBe(false);
      yield* networkBansGet({ remote: Option.none(), projectRef: Option.none() });
      expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        "GET https://api.supabase.com/v1/projects",
        `POST https://api.supabase.com/v1/projects/${VALID_REF}/network-bans/retrieve`,
        `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
      ]);
      expect(out.stdoutText).toBe('[\n  "192.168.0.1",\n  "192.168.0.2"\n]\n');
      expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
        ref: VALID_REF,
      });
      assertPermissionDrift({
        command: "network-bans get",
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects an empty --project-ref before the picker or any request", () => {
    const out = mockOutput();
    const api = mockCommandPlatformApi({ response: { status: 201, body: SAMPLE_BANS } });
    const layer = buildTestRuntime({
      out,
      api,
      cliSettings: mockCommandSettings({ workdir: tempRoot.current, projectId: Option.none() }),
      tty: mockTty({ stdinIsTty: true }),
    });
    return Effect.gen(function* () {
      const error = yield* networkBansGet({
        remote: Option.none(),
        projectRef: Option.some(""),
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "TargetEmptyValueError", flag: "--project-ref" });
      expect(out.promptSelectCalls).toHaveLength(0);
      expect(api.requests).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses the --remote=<ref> value over CommandSettings.projectId", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* networkBansGet({
        remote: Option.some({ _tag: "Ref", ref: flagRef }),
        projectRef: Option.none(),
      });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${flagRef}/`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with NetworkBansGetUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        networkBansGet({ remote: Option.none(), projectRef: Option.none() }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("NetworkBansGetUnexpectedStatusError");
        expect(causeText).toContain("unexpected list bans status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a network error when the API transport fails", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        networkBansGet({ remote: Option.none(), projectRef: Option.none() }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("NetworkBansGetNetworkError");
        expect(causeText).toContain("failed to list network bans:");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a fail event when withJsonErrorHandling wraps a JSON-mode error", () => {
    const { layer, out } = setup({ format: "json", status: 503 });
    return Effect.gen(function* () {
      yield* networkBansGet({ remote: Option.none(), projectRef: Option.none() }).pipe(
        withJsonErrorHandling,
      );
      expect(out.messages.some((m) => m.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("flushes telemetry and writes linked-project cache on success", () => {
    const { layer, telemetry, cache } = setupTracked();
    return Effect.gen(function* () {
      yield* networkBansGet({ remote: Option.none(), projectRef: Option.none() });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("flushes telemetry even on API failure", () => {
    const { layer, telemetry, cache } = setupTracked({ status: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        networkBansGet({ remote: Option.none(), projectRef: Option.none() }).pipe(
          Effect.provide(layer),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(telemetry.flushed).toBe(true);
      // Linked-project cache wraps the inner effect, so it still fires after
      // ref resolution succeeded, once ref is known.
      expect(cache.cached).toBe(true);
    });
  });

  describeHostedTargetSelection("network-bans get", {
    respond: (request) => Effect.succeed(jsonResponse(request, 201, SAMPLE_BANS)),
    run: (flags) => networkBansGet(flags),
  });
});
