import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, FileSystem, Schema } from "effect";

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
import { describeHostedConsent } from "../../../../tests/helpers/hosted-consent.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import {
  projectResponse,
  realLinkedProjectCache,
} from "../../../../tests/helpers/permission-real-layers.ts";
import { domainsDelete } from "./delete.handler.ts";
import { YesFlag } from "../../../command-internal/global-flags.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";

type OutputFlagValue = "env" | "pretty" | "json" | "toml" | "yaml";

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly outputFlag?: OutputFlagValue;
  readonly status?: number;
  readonly network?: "fail";
}

const tempRoot = useTempWorkdir("supabase-domains-delete-int-");

const buildRuntime = (opts: Parameters<typeof buildTestRuntime>[0]) =>
  Layer.mergeAll(
    buildTestRuntime(opts),
    Layer.succeed(YesFlag, true),
    Layer.succeed(TargetPolicy, { group: "hosted", consent: "no" }),
  );

const confirmed = `Confirmed by --yes: Delete the custom hostname config on project ${VALID_REF} · identity unverified\n`;
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockCommandPlatformApi({
    response: { status: opts.status ?? 200, body: {} },
    network: opts.network,
  });
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const telemetry = mockTelemetryStateTracked();
  const linkedProjectCache = mockLinkedProjectCacheTracked();
  const layer = buildRuntime({
    out,
    api,
    cliSettings,
    telemetry: telemetry.layer,
    linkedProjectCache: linkedProjectCache.layer,
    outputFlag: opts.outputFlag === undefined ? Option.none() : Option.some(opts.outputFlag),
  });
  return { layer, out, api, telemetry, linkedProjectCache };
}

const baseFlags = { projectRef: Option.none<string>(), includeRawOutput: Option.none<boolean>() };

describe("domains delete integration", () => {
  it.effect("prints the success line to stderr in text mode", () => {
    const { layer, out, api, telemetry, linkedProjectCache } = setup();
    return Effect.gen(function* () {
      yield* domainsDelete(baseFlags);
      expect(out.stderrText).toBe(
        unverifiedTargetBanner() + confirmed + "Deleted custom hostname config successfully.\n",
      );
      expect(out.stdoutText).toBe("");
      expect(api.requests[0]?.method).toBe("DELETE");
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cached).toBe(true);
      assertPermissionDrift({ command: "domains delete", requests: api.requests, exact: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a structured success event for --output-format json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* domainsDelete(baseFlags);
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.message).toBe("Deleted custom hostname config successfully.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a structured success event for --output-format stream-json", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* domainsDelete(baseFlags);
      expect(out.messages.some((m) => m.type === "success")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("ignores -o json and still only prints to stderr", () => {
    const { layer, out } = setup({ outputFlag: "json" });
    return Effect.gen(function* () {
      yield* domainsDelete(baseFlags);
      expect(out.stdoutText).toBe("");
      expect(out.stderrText).toBe(
        unverifiedTargetBanner() + confirmed + "Deleted custom hostname config successfully.\n",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with DomainsUnexpectedStatusError on HTTP 503", () => {
    const { layer, telemetry, linkedProjectCache } = setup({ status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(domainsDelete(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("unexpected delete hostname status 503");
      }
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with DomainsNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(domainsDelete(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("failed to delete custom hostname");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps an HTTP error without a spinner in json mode", () => {
    const { layer, out } = setup({ format: "json", status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(domainsDelete(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.progressEvents).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "picks the project, deletes the hostname config and fills the linked-project cache through the real layers",
    () => {
      const out = mockOutput({ promptSelectResponses: [VALID_REF] });
      const api = mockCommandPlatformApi({
        handler: (request) => {
          const route = `${request.method} ${request.url}`;
          if (route === "GET https://api.supabase.com/v1/projects") {
            return Effect.succeed(jsonResponse(request, 200, [projectResponse(VALID_REF)]));
          }
          if (route === `GET https://api.supabase.com/v1/projects/${VALID_REF}`) {
            return Effect.succeed(jsonResponse(request, 200, projectResponse(VALID_REF)));
          }
          if (
            route === `DELETE https://api.supabase.com/v1/projects/${VALID_REF}/custom-hostname`
          ) {
            return Effect.succeed(jsonResponse(request, 200, {}));
          }
          return Effect.succeed(jsonResponse(request, 404, { message: "unexpected request" }));
        },
      });
      const cliSettings = mockCommandSettings({
        workdir: tempRoot.current,
        projectId: Option.none(),
      });
      const layer = buildRuntime({
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
        yield* domainsDelete(baseFlags);
        expect(out.stderrText).toBe("Deleted custom hostname config successfully.\n");
        expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
          "GET https://api.supabase.com/v1/projects",
          `DELETE https://api.supabase.com/v1/projects/${VALID_REF}/custom-hostname`,
          `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
        ]);
        expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
          ref: VALID_REF,
        });
        assertPermissionDrift({ command: "domains delete", requests: api.requests, exact: true });
      }).pipe(Effect.provide(layer));
    },
  );
});

describeHostedConsent("domains delete", {
  api: { response: { status: 200, body: {} } },
  invoke: () => ({ run: domainsDelete(baseFlags) }),
});
