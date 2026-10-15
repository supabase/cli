import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  buildTestRuntime,
  jsonResponse,
  mockCommandSettings,
  mockCommandPlatformApi,
  useTempWorkdir,
  unverifiedTargetBanner,
} from "../../../../tests/helpers/command-mocks.ts";
import { describeHostedConsent } from "../../../../tests/helpers/hosted-consent.ts";
import type { BranchesUnpauseFlags } from "./unpause.command.ts";
import { branchesUnpause } from "./unpause.handler.ts";
import { YesFlag } from "../../../command-internal/global-flags.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";

// 20-lowercase ref (matches V1RestoreAProjectInput.ref plain pattern).
const BRANCH_REF = "cccccccccccccccccccc";

const tempRoot = useTempWorkdir("supabase-branches-unpause-int-");

const buildRuntime = (opts: Parameters<typeof buildTestRuntime>[0]) =>
  Layer.mergeAll(
    buildTestRuntime(opts),
    Layer.succeed(YesFlag, true),
    Layer.succeed(TargetPolicy, { group: "hosted", consent: "no" }),
  );

const confirmed = `Confirmed by --yes: Unpause preview branch ${BRANCH_REF} on project ${VALID_REF} · identity unverified\n`;

interface SetupOpts {
  readonly restoreStatus?: number;
}

function setup(opts: SetupOpts = {}) {
  const restoreStatus = opts.restoreStatus ?? 200;
  const out = mockOutput({ format: "text" });
  const api = mockCommandPlatformApi({
    handler: (request) =>
      Effect.sync(() => {
        if (request.method === "POST" && request.url.endsWith("/restore")) {
          return jsonResponse(request, restoreStatus, null);
        }
        return jsonResponse(request, 200, null);
      }),
  });
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const layer = buildRuntime({ out, api, cliSettings });
  return { layer, out, api };
}

const baseFlags: BranchesUnpauseFlags = {
  name: Option.none(),
  projectRef: Option.none(),
};

describe("branches unpause integration", () => {
  it.effect("unpauses a branch given a project-ref pattern", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* branchesUnpause({ ...baseFlags, name: Option.some(BRANCH_REF) });
      expect(api.requests.find((r) => r.method === "POST")?.url).toContain(
        `/v1/projects/${BRANCH_REF}/restore`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("is silent on stdout/stderr on success", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* branchesUnpause({ ...baseFlags, name: Option.some(BRANCH_REF) });
      expect(out.stdoutText).toBe("");
      expect(out.stderrText).toBe(unverifiedTargetBanner() + confirmed);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with BranchesUnpauseUnexpectedStatusError on non-200", () => {
    const { layer } = setup({ restoreStatus: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        branchesUnpause({ ...baseFlags, name: Option.some(BRANCH_REF) }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("BranchesUnpauseUnexpectedStatusError");
        expect(causeText).toContain("unexpected unpause branch status 500");
      }
    }).pipe(Effect.provide(layer));
  });
});

describeHostedConsent("branches unpause", {
  api: { response: { status: 200, body: null } },
  invoke: () => ({ run: branchesUnpause({ ...baseFlags, name: Option.some(BRANCH_REF) }) }),
});
