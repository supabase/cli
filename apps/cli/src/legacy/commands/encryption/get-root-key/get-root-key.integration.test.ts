import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  LEGACY_VALID_REF,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { legacyEncryptionGetRootKey } from "./get-root-key.handler.ts";

const ROOT_KEY_RESPONSE = { root_key: "abc123rootkey" };

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly status?: number;
  readonly network?: "fail";
  readonly projectId?: Option.Option<string>;
}

const tempRoot = useLegacyTempWorkdir("supabase-encryption-get-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 200, body: ROOT_KEY_RESPONSE },
    network: opts.network,
  });
  const cliConfig = mockLegacyCliConfig({
    workdir: tempRoot.current,
    projectId: opts.projectId ?? Option.some(LEGACY_VALID_REF),
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const linkedProjectCache = mockLegacyLinkedProjectCacheTracked();
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    telemetry: telemetry.layer,
    linkedProjectCache: linkedProjectCache.layer,
  });
  return { layer, out, api, telemetry, linkedProjectCache };
}

const baseFlags = { projectRef: Option.none<string>() };

describe("legacy encryption get-root-key integration", () => {
  it.live("prints the root key to stdout in text mode", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyEncryptionGetRootKey(baseFlags);
      expect(out.stdoutText).toBe("abc123rootkey\n");
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits the root key as a structured result in json mode", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyEncryptionGetRootKey(baseFlags);
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.message).toBe("");
      expect(success?.data).toEqual({ root_key: "abc123rootkey" });
    }).pipe(Effect.provide(layer));
  });

  it.live("streams the root key as a result event in stream-json mode", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* legacyEncryptionGetRootKey(baseFlags);
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toEqual({ root_key: "abc123rootkey" });
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves the ref from the --project-ref flag", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyEncryptionGetRootKey({ projectRef: Option.some(flagRef) });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${flagRef}/pgsodium`);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with a transport error when the network is down", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyEncryptionGetRootKey(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyEncryptionNetworkError");
        expect(json).toContain("failed to retrieve pgsodium config");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with an unexpected-status error on a 503", () => {
    const { layer } = setup({ status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyEncryptionGetRootKey(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyEncryptionUnexpectedStatusError");
        expect(json).toContain("unexpected get pgsodium config status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("does not start a spinner in json mode on failure", () => {
    const { layer, out } = setup({ format: "json", status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyEncryptionGetRootKey(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.progressEvents).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when no project ref can be resolved", () => {
    const { layer } = setup({ projectId: Option.none() });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyEncryptionGetRootKey(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyProjectNotLinkedError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("writes the linked-project cache and flushes telemetry on success", () => {
    const { layer, telemetry, linkedProjectCache } = setup();
    return Effect.gen(function* () {
      yield* legacyEncryptionGetRootKey(baseFlags);
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("writes the linked-project cache and flushes telemetry on failure", () => {
    const { layer, telemetry, linkedProjectCache } = setup({ status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyEncryptionGetRootKey(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
