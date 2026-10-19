import { describe, expect } from "vitest";
import { linkProject } from "./link-project.ts";
import { testBehaviour } from "./test-context.ts";

const BRANCH_PROJECT_REF = "bbbbbbbbbbbbbbbbbbbb";
const DEAD_DB_URL = "postgresql://postgres:postgres@localhost:1/postgres";

interface RequestEntry {
  method: string;
  pathname: string;
}

async function getRequestLog(apiUrl: string): Promise<RequestEntry[]> {
  const res = await fetch(`${apiUrl}/_ctrl/requests`);
  return res.json() as Promise<RequestEntry[]>;
}

describe("deprecated target aliases", () => {
  testBehaviour(
    "warns that --linked is deprecated and still targets the linked project",
    async ({ run, projectRef, workspace }) => {
      linkProject(workspace.path, projectRef);
      const result = await run(["db", "advisors", "--type", "security", "--linked"]);
      expect(result.exitCode).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "--linked is deprecated and will be removed in v4. Use --remote instead: supabase db advisors --type security --remote",
      );
      expect(result.stderr).toContain("No issues found");
    },
  );

  testBehaviour("warns that --local is not needed and still targets local", async ({ run }) => {
    const result = await run(["db", "push", "--local"]);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "--local isn't needed (local is the default) and will be removed in v4: supabase db push",
    );
    expect(result.stderr).toContain("Target: local stack");
    expect(result.stderr).toContain("failed to connect to postgres");
  });

  testBehaviour(
    "warns that --db-url is deprecated and still targets that database",
    async ({ run }) => {
      const result = await run(["inspect", "db", "db-stats", "--db-url", DEAD_DB_URL]);
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "--db-url is deprecated and will be removed in v4. Use --remote instead: supabase inspect db db-stats --remote=<db-url>",
      );
      expect(`${result.stdout}${result.stderr}`).not.toContain(DEAD_DB_URL);
      expect(result.stderr).toContain("Target: custom Postgres (localhost:1)");
    },
  );

  testBehaviour(
    "warns that --project-ref is deprecated on a hosted command and still targets that project",
    async ({ run, projectRef }) => {
      const result = await run(["secrets", "list", "--project-ref", projectRef]);
      expect(result.exitCode).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        `--project-ref is deprecated and will be removed in v4. Use --remote instead: supabase secrets list --remote=${projectRef}`,
      );
    },
  );

  testBehaviour(
    "warns that --project-id is deprecated on gen types and still targets that project",
    async ({ run, projectRef }) => {
      const result = await run(["gen", "types", "--project-id", projectRef]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("export type Database");
      expect(`${result.stdout}${result.stderr}`).toContain(
        `--project-id is deprecated and will be removed in v4. Use --remote instead: supabase gen types --remote=${projectRef}`,
      );
    },
  );
});

describe("remote target selection", () => {
  testBehaviour(
    "runs a bare db push locally in a linked checkout and hints at --remote",
    async ({ run, projectRef, workspace, apiUrl }) => {
      linkProject(workspace.path, projectRef);
      const result = await run(["db", "push"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(`Target: local stack`);
      expect(result.stderr).toContain(`default; pass --remote for ${projectRef}`);
      expect(result.stderr).not.toContain("Target: project");
      const requests = await getRequestLog(apiUrl);
      expect(requests.filter((r) => r.pathname.includes("/database/"))).toEqual([]);
    },
  );

  testBehaviour(
    "targets the project named by --remote=<ref>",
    async ({ run, projectRef, workspace, apiUrl }) => {
      linkProject(workspace.path, projectRef);
      const result = await run(["db", "advisors", "--type", "security", `--remote=${projectRef}`]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("No issues found");
      const requests = await getRequestLog(apiUrl);
      expect(requests.map((r) => `${r.method} ${r.pathname}`)).toContain(
        `GET /v1/projects/${projectRef}/advisors/security`,
      );
    },
  );

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

  testBehaviour(
    "resolves --remote=<branch> on a hosted command through the linked project's branches",
    async ({ run, projectRef, workspace, apiUrl }) => {
      linkProject(workspace.path, projectRef);
      const result = await run(["secrets", "list", "--remote=my-branch"]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(
        `Target: project ${projectRef} · branch my-branch (${BRANCH_PROJECT_REF})`,
      );
      const requests = await getRequestLog(apiUrl);
      expect(requests.map((r) => `${r.method} ${r.pathname}`)).toEqual(
        expect.arrayContaining([
          `GET /v1/projects/${projectRef}/branches`,
          `GET /v1/projects/${BRANCH_PROJECT_REF}/secrets`,
        ]),
      );
    },
  );

  testBehaviour("rejects --remote=<url> on a hosted command", async ({ run, apiUrl }) => {
    const result = await run(["secrets", "list", `--remote=${DEAD_DB_URL}`]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("needs a project, not a database URL");
    const requests = await getRequestLog(apiUrl);
    expect(requests.filter((r) => r.pathname.endsWith("/secrets"))).toEqual([]);
  });
});
