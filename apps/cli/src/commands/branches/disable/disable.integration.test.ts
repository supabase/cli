import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  buildTestRuntime,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { describeHostedConsent } from "../../../../tests/helpers/hosted-consent.ts";
import type { BranchesDisableFlags } from "./disable.command.ts";
import { branchesDisable } from "./disable.handler.ts";
import { YesFlag } from "../../../command-internal/global-flags.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";

const tempRoot = useTempWorkdir("supabase-branches-disable-int-");

const buildRuntime = (opts: Parameters<typeof buildTestRuntime>[0]) =>
  Layer.mergeAll(
    buildTestRuntime(opts),
    Layer.succeed(YesFlag, true),
    Layer.succeed(TargetPolicy, { group: "hosted", consent: "no" }),
  );

interface SetupOpts {
  readonly status?: number;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: "text" });
  const api = mockCommandPlatformApi({
    response: { status: opts.status ?? 200, body: null },
  });
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const layer = buildRuntime({ out, api, cliSettings });
  return { layer, out, api };
}

function setupTracked(opts: SetupOpts = {}) {
  const out = mockOutput({ format: "text" });
  const api = mockCommandPlatformApi({
    response: { status: opts.status ?? 200, body: null },
  });
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
  const layer = buildRuntime({
    out,
    api,
    cliSettings,
    telemetry: telemetry.layer,
    linkedProjectCache: cache.layer,
  });
  return { layer, out, api, telemetry, cache };
}

const baseFlags: BranchesDisableFlags = {
  projectRef: Option.none(),
};

describe("branches disable integration", () => {
  it.effect("disables preview branching and emits header to stdout", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* branchesDisable(baseFlags);
      expect(out.stdoutText).toContain(`Disabled preview branching for project: ${VALID_REF}`);
      expect(api.requests.find((r) => r.method === "DELETE")?.url).toContain(
        `/v1/projects/${VALID_REF}/branches`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with BranchesDisableUnexpectedStatusError on non-200", () => {
    const { layer } = setup({ status: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(branchesDisable(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("BranchesDisableUnexpectedStatusError");
        expect(causeText).toContain("unexpected disable branching status 500");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes linked-project cache + telemetry state on success", () => {
    const { layer, telemetry, cache } = setupTracked();
    return Effect.gen(function* () {
      yield* branchesDisable(baseFlags);
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});

describeHostedConsent("branches disable", {
  api: { response: { status: 200, body: null } },
  invoke: () => ({ run: branchesDisable(baseFlags) }),
});
