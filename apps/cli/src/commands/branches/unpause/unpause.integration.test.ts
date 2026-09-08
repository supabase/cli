import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import {
  buildTestRuntime,
  jsonResponse,
  mockCommandSettings,
  mockCommandPlatformApi,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import type { BranchesUnpauseFlags } from "./unpause.command.ts";
import { branchesUnpause } from "./unpause.handler.ts";

// 20-lowercase ref (matches V1RestoreAProjectInput.ref plain pattern).
const BRANCH_REF = "cccccccccccccccccccc";

const tempRoot = useTempWorkdir("supabase-branches-unpause-int-");

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
  const layer = buildTestRuntime({ out, api, cliSettings });
  return { layer, out, api };
}

const baseFlags: BranchesUnpauseFlags = {
  name: Option.none(),
  projectRef: Option.none(),
};

describe("branches unpause integration", () => {
  it.live("unpauses a branch given a project-ref pattern", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* branchesUnpause({ ...baseFlags, name: Option.some(BRANCH_REF) });
      expect(api.requests.find((r) => r.method === "POST")?.url).toContain(
        `/v1/projects/${BRANCH_REF}/restore`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("is silent on stdout/stderr on success", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* branchesUnpause({ ...baseFlags, name: Option.some(BRANCH_REF) });
      expect(out.stdoutText).toBe("");
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with BranchesUnpauseUnexpectedStatusError on non-200", () => {
    const { layer } = setup({ restoreStatus: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        branchesUnpause({ ...baseFlags, name: Option.some(BRANCH_REF) }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("BranchesUnpauseUnexpectedStatusError");
        expect(json).toContain("unexpected unpause branch status 500");
      }
    }).pipe(Effect.provide(layer));
  });
});
