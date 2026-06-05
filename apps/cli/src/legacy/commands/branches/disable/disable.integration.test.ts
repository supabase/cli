import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

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
import type { LegacyBranchesDisableFlags } from "./disable.command.ts";
import { legacyBranchesDisable } from "./disable.handler.ts";

const tempRoot = useLegacyTempWorkdir("supabase-branches-disable-int-");

interface SetupOpts {
  readonly status?: number;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 200, body: null },
  });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const layer = buildLegacyTestRuntime({ out, api, cliConfig });
  return { layer, out, api };
}

function setupTracked(opts: SetupOpts = {}) {
  const out = mockOutput({ format: "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 200, body: null },
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

const baseFlags: LegacyBranchesDisableFlags = {
  projectRef: Option.none(),
};

describe("legacy branches disable integration", () => {
  it.live("disables preview branching and emits header to stdout", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBranchesDisable(baseFlags);
      expect(out.stdoutText).toContain(
        `Disabled preview branching for project: ${LEGACY_VALID_REF}`,
      );
      expect(api.requests.find((r) => r.method === "DELETE")?.url).toContain(
        `/v1/projects/${LEGACY_VALID_REF}/branches`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyBranchesDisableUnexpectedStatusError on non-200", () => {
    const { layer } = setup({ status: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyBranchesDisable(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyBranchesDisableUnexpectedStatusError");
        expect(json).toContain("unexpected disable branching status 500");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("writes linked-project cache + telemetry state on success", () => {
    const { layer, telemetry, cache } = setupTracked();
    return Effect.gen(function* () {
      yield* legacyBranchesDisable(baseFlags);
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
