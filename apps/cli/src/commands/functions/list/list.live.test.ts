import { Effect } from "effect";
import { describe, expect } from "vitest";

import { test } from "../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 120_000;

// TODO(CLI-1834): add deploy + invoke coverage over :443 / {ref}.supabase.red once the project's
// gateway is reachable from the host.
describe("supabase functions list (live)", () => {
  test(
    "lists edge functions for the project",
    { timeout: LIVE_TIMEOUT_MS },
    ({ cliEffect, project, signal }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { exitCode, stdout, stderr } = yield* cliEffect([
            "functions",
            "list",
            "--project-ref",
            project.ref,
          ]);
          expect(exitCode, stderr).toBe(0);
          expect(stdout, stderr).toMatch(/ID\s+\|\s+NAME\s+\|\s+SLUG\s+\|\s+STATUS/);
        }),
        { signal },
      ),
  );
});
