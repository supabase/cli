import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { legacyDomainsDelete } from "./delete.handler.ts";

type GoOutput = "env" | "pretty" | "json" | "toml" | "yaml";

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly goOutput?: GoOutput;
  readonly status?: number;
  readonly network?: "fail";
}

const tempRoot = useLegacyTempWorkdir("supabase-domains-delete-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 200, body: {} },
    network: opts.network,
  });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const telemetry = mockLegacyTelemetryStateTracked();
  const linkedProjectCache = mockLegacyLinkedProjectCacheTracked();
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    telemetry: telemetry.layer,
    linkedProjectCache: linkedProjectCache.layer,
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
  });
  return { layer, out, api, telemetry, linkedProjectCache };
}

const baseFlags = { projectRef: Option.none<string>(), includeRawOutput: false };

describe("legacy domains delete integration", () => {
  it.live("prints the success line to stderr in text mode", () => {
    const { layer, out, api, telemetry, linkedProjectCache } = setup();
    return Effect.gen(function* () {
      yield* legacyDomainsDelete(baseFlags);
      expect(out.stderrText).toBe("Deleted custom hostname config successfully.\n");
      expect(out.stdoutText).toBe("");
      expect(api.requests[0]?.method).toBe("DELETE");
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a structured success event for --output-format json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyDomainsDelete(baseFlags);
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.message).toBe("Deleted custom hostname config successfully.");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a structured success event for --output-format stream-json", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* legacyDomainsDelete(baseFlags);
      expect(out.messages.some((m) => m.type === "success")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("ignores -o json and still only prints to stderr (Go parity)", () => {
    const { layer, out } = setup({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* legacyDomainsDelete(baseFlags);
      expect(out.stdoutText).toBe("");
      expect(out.stderrText).toBe("Deleted custom hostname config successfully.\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("ignores --include-raw-output (inert on delete, Go parity)", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyDomainsDelete({ projectRef: Option.none(), includeRawOutput: true });
      expect(out.stdoutText).toBe("");
      expect(out.stderrText).toBe("Deleted custom hostname config successfully.\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyDomainsUnexpectedStatusError on HTTP 503", () => {
    const { layer, telemetry, linkedProjectCache } = setup({ status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDomainsDelete(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("unexpected delete hostname status 503");
      }
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyDomainsNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDomainsDelete(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to delete custom hostname");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("maps an HTTP error without a spinner in json mode", () => {
    const { layer, out } = setup({ format: "json", status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDomainsDelete(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.progressEvents).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});
