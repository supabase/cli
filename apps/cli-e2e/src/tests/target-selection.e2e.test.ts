import { describe, expect } from "vitest";
import { linkProject } from "./link-project.ts";
import { getRequestLog } from "./request-log.ts";
import { testBehaviour } from "./test-context.ts";

const DEAD_DB_URL = "postgresql://postgres:postgres@localhost:1/postgres";

describe("remote target selection", () => {
  testBehaviour(
    "reads a space-separated --remote <ref> as --remote=<ref>",
    async ({ run, projectRef, workspace, apiUrl }) => {
      linkProject(workspace.path, projectRef);
      const result = await run(["db", "advisors", "--type", "security", "--remote", projectRef]);
      expect(result.exitCode).toBe(0);
      const requests = await getRequestLog(apiUrl);
      expect(requests.map((r) => `${r.method} ${r.pathname}`)).toContain(
        `GET /v1/projects/${projectRef}/advisors/security`,
      );
    },
  );

  testBehaviour("rejects --remote=<url> on a hosted command", async ({ run, apiUrl }) => {
    const result = await run(["secrets", "list", `--remote=${DEAD_DB_URL}`]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--remote takes a project ref or a branch name.");
    const requests = await getRequestLog(apiUrl);
    expect(requests.filter((r) => r.pathname.endsWith("/secrets"))).toEqual([]);
  });
});
