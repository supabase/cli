import { V1GetNetworkRestrictionsOutput } from "@supabase/api/effect";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import {
  experimentalProjectLiveFlags,
  requireLiveJson,
  test,
} from "../../../../tests/helpers/live.ts";

// Sibling tests mutate the shared project's allowlist, so the golden path pins
// the payload against the generated contract rather than a concrete config.
test("reads the network restrictions of the target project", ({ cliEffect, project, signal }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* cliEffect([
        "network-restrictions",
        "get",
        ...experimentalProjectLiveFlags(project),
        "-o",
        "json",
      ]);
      expect(result.exitCode, result.stderr).toBe(0);
      const payload = requireLiveJson(result, "network-restrictions get");
      expect(
        Schema.is(V1GetNetworkRestrictionsOutput)(payload),
        `unexpected network-restrictions get payload\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(true);
    }),
    { signal },
  ));
