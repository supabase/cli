import { Effect } from "effect";
import { describe, expect } from "vitest";
import { linkProject } from "./link-project.ts";
import { getRequestLog } from "./request-log.ts";
import { runE2e, testBehaviour } from "./test-context.ts";

const DEAD_DB_URL = "postgresql://postgres:postgres@localhost:1/postgres";

describe("remote target selection", () => {
  testBehaviour(
    "reads a space-separated --remote <ref> as --remote=<ref>",
    ({ run, projectRef, workspace, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* linkProject(workspace.path, projectRef);
          const result = yield* run([
            "db",
            "advisors",
            "--type",
            "security",
            "--remote",
            projectRef,
          ]);
          expect(result.exitCode).toBe(0);
          const requests = yield* getRequestLog(apiUrl);
          expect(requests.map((r) => `${r.method} ${r.pathname}`)).toContain(
            `GET /v1/projects/${projectRef}/advisors/security`,
          );
        }),
        signal,
      ),
  );

  testBehaviour("rejects --remote=<url> on a hosted command", ({ run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        const result = yield* run(["secrets", "list", `--remote=${DEAD_DB_URL}`]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("--remote takes a project ref or a branch name.");
        const requests = yield* getRequestLog(apiUrl);
        expect(requests.filter((r) => r.pathname.endsWith("/secrets"))).toEqual([]);
      }),
      signal,
    ),
  );
});
