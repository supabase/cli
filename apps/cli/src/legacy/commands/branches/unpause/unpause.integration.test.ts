import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  legacyJsonResponse,
  mockLegacyCliConfig,
  mockLegacyPlatformApi,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import type { LegacyBranchesUnpauseFlags } from "./unpause.command.ts";
import { legacyBranchesUnpause } from "./unpause.handler.ts";

// 20-lowercase ref (matches V1RestoreAProjectInput.ref plain pattern).
const BRANCH_REF = "cccccccccccccccccccc";

const tempRoot = useLegacyTempWorkdir("supabase-branches-unpause-int-");

interface SetupOpts {
  readonly restoreStatus?: number;
}

function setup(opts: SetupOpts = {}) {
  const restoreStatus = opts.restoreStatus ?? 200;
  const out = mockOutput({ format: "text" });
  const api = mockLegacyPlatformApi({
    handler: (request) =>
      Effect.sync(() => {
        if (request.method === "POST" && request.url.endsWith("/restore")) {
          return legacyJsonResponse(request, restoreStatus, null);
        }
        return legacyJsonResponse(request, 200, null);
      }),
  });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const layer = buildLegacyTestRuntime({ out, api, cliConfig });
  return { layer, out, api };
}

const baseFlags: LegacyBranchesUnpauseFlags = {
  name: Option.none(),
  projectRef: Option.none(),
};

describe("legacy branches unpause integration", () => {
  it.live("unpauses a branch given a project-ref pattern", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBranchesUnpause({ ...baseFlags, name: Option.some(BRANCH_REF) });
      expect(api.requests.find((r) => r.method === "POST")?.url).toContain(
        `/v1/projects/${BRANCH_REF}/restore`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("is silent on stdout/stderr on success", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyBranchesUnpause({ ...baseFlags, name: Option.some(BRANCH_REF) });
      expect(out.stdoutText).toBe("");
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyBranchesUnpauseUnexpectedStatusError on non-200", () => {
    const { layer } = setup({ restoreStatus: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyBranchesUnpause({ ...baseFlags, name: Option.some(BRANCH_REF) }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyBranchesUnpauseUnexpectedStatusError");
        expect(json).toContain("unexpected unpause branch status 500");
      }
    }).pipe(Effect.provide(layer));
  });
});
