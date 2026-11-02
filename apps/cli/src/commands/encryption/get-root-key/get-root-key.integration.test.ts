import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Schema } from "effect";

import { mockOutput, mockTty } from "../../../../tests/helpers/mocks.ts";
import {
  buildTestRuntime,
  jsonResponse,
  VALID_REF,
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
import { encryptionGetRootKey } from "./get-root-key.handler.ts";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const ROOT_KEY_RESPONSE = { root_key: "abc123rootkey" };

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly status?: number;
  readonly network?: "fail";
  readonly projectId?: Option.Option<string>;
}

const tempRoot = useTempWorkdir("supabase-encryption-get-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockCommandPlatformApi({
    response: { status: opts.status ?? 200, body: ROOT_KEY_RESPONSE },
    network: opts.network,
  });
  const cliSettings = mockCommandSettings({
    workdir: tempRoot.current,
    projectId: opts.projectId ?? Option.some(VALID_REF),
  });
  const telemetry = mockTelemetryStateTracked();
  const linkedProjectCache = mockLinkedProjectCacheTracked();
  const layer = buildTestRuntime({
    out,
    api,
    cliSettings,
    telemetry: telemetry.layer,
    linkedProjectCache: linkedProjectCache.layer,
  });
  return { layer, out, api, telemetry, linkedProjectCache };
}

const baseFlags = { remote: Option.none(), projectRef: Option.none<string>() };

describe("encryption get-root-key integration", () => {
  it.effect("prints the root key to stdout in text mode", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* encryptionGetRootKey(baseFlags);
      expect(out.stdoutText).toBe("abc123rootkey\n");
      expect(out.stderrText).toBe(unverifiedTargetBanner());
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits the root key as a structured result in json mode", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* encryptionGetRootKey(baseFlags);
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.message).toBe("");
      expect(success?.data).toEqual({ root_key: "abc123rootkey" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("streams the root key as a result event in stream-json mode", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* encryptionGetRootKey(baseFlags);
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toEqual({ root_key: "abc123rootkey" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves the ref from the --remote=<ref> flag", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* encryptionGetRootKey({
        remote: Option.some({ _tag: "Ref", ref: flagRef }),
        projectRef: Option.none(),
      });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${flagRef}/pgsodium`);
      assertPermissionDrift({
        command: "encryption get-root-key",
        activeFlags: { remote: flagRef },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists projects for the picker and fills the real linked-project cache", () => {
    const out = mockOutput({ promptSelectResponses: [VALID_REF] });
    const api = mockCommandPlatformApi({
      handler: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/v1/projects") {
          return Effect.succeed(jsonResponse(request, 200, [projectResponse(VALID_REF)]));
        }
        if (path === `/v1/projects/${VALID_REF}`) {
          return Effect.succeed(jsonResponse(request, 200, projectResponse(VALID_REF)));
        }
        if (path === `/v1/projects/${VALID_REF}/pgsodium`) {
          return Effect.succeed(jsonResponse(request, 200, ROOT_KEY_RESPONSE));
        }
        return Effect.succeed(jsonResponse(request, 404, { message: "unexpected request" }));
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
      linkedProjectCache: realLinkedProjectCache({ httpClient: api.httpClientLayer, cliSettings }),
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* encryptionGetRootKey(baseFlags);
      expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        "GET https://api.supabase.com/v1/projects",
        `GET https://api.supabase.com/v1/projects/${VALID_REF}/pgsodium`,
        `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
      ]);
      expect(out.stdoutText).toBe("abc123rootkey\n");
      const cachePath = `${tempRoot.current}/supabase/.temp/linked-project.json`;
      expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
        ref: VALID_REF,
      });
      assertPermissionDrift({
        command: "encryption get-root-key",
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with a transport error when the network is down", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(encryptionGetRootKey(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("EncryptionNetworkError");
        expect(causeText).toContain("failed to retrieve pgsodium config");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with an unexpected-status error on a 503", () => {
    const { layer } = setup({ status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(encryptionGetRootKey(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("EncryptionUnexpectedStatusError");
        expect(causeText).toContain("unexpected get pgsodium config status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not start a spinner in json mode on failure", () => {
    const { layer, out } = setup({ format: "json", status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(encryptionGetRootKey(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.progressEvents).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails when no project ref can be resolved", () => {
    const { layer } = setup({ projectId: Option.none() });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(encryptionGetRootKey(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("ProjectRefNotLinkedError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes the linked-project cache and flushes telemetry on success", () => {
    const { layer, telemetry, linkedProjectCache } = setup();
    return Effect.gen(function* () {
      yield* encryptionGetRootKey(baseFlags);
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes the linked-project cache and flushes telemetry on failure", () => {
    const { layer, telemetry, linkedProjectCache } = setup({ status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(encryptionGetRootKey(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});

describeHostedTargetSelection("encryption get-root-key", {
  respond: (request) => Effect.succeed(jsonResponse(request, 200, ROOT_KEY_RESPONSE)),
  run: (flags) => encryptionGetRootKey(flags),
});
