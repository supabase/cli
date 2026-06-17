import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { testLive } from "./live-context.ts";

// Write a throwaway Edge Function into the test workspace so the lifecycle tests
// own a dedicated slug (the shared per-run project is cleaned up on teardown).
function writeFunction(workspacePath: string, slug: string, jsonBody: string): void {
  const dir = join(workspacePath, "supabase", "functions", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), `Deno.serve(() => Response.json(${jsonBody}));\n`);
  writeFileSync(join(dir, "deno.json"), `{\n  "imports": {}\n}\n`);
}

// Active (non-REMOVED) function slugs. The Management API can keep deleted
// functions in the list with status REMOVED (the Go prune path skips them), so a
// successful delete may leave a REMOVED row — filter those out.
function activeSlugs(stdout: string): string[] {
  return (JSON.parse(stdout) as Array<{ slug?: string; name?: string; status?: string }>)
    .filter((f) => (f.status ?? "").toUpperCase() !== "REMOVED")
    .map((f) => f.slug ?? f.name ?? "");
}

describe("functions update + delete (live)", () => {
  // There is no dedicated `functions update` command — re-deploying a slug
  // upserts it. Verify the second deploy replaces the running code.
  testLive(
    "re-deploying a function updates the running code",
    async ({ run, invoke, workspace, projectRef }) => {
      const slug = "deploy-e2e-update";

      writeFunction(workspace.path, slug, `{ case: "${slug}", version: 1 }`);
      expect((await run(["functions", "deploy", slug, "--project-ref", projectRef])).exitCode).toBe(
        0,
      );
      expect((await invoke(slug)).body).toMatchObject({ case: slug, version: 1 });

      writeFunction(workspace.path, slug, `{ case: "${slug}", version: 2 }`);
      expect((await run(["functions", "deploy", slug, "--project-ref", projectRef])).exitCode).toBe(
        0,
      );
      expect((await invoke(slug)).body).toMatchObject({ case: slug, version: 2 });
    },
  );

  testLive("delete removes a deployed function", async ({ run, workspace, projectRef }) => {
    const slug = "deploy-e2e-delete";

    writeFunction(workspace.path, slug, `{ case: "${slug}", ok: true }`);
    expect((await run(["functions", "deploy", slug, "--project-ref", projectRef])).exitCode).toBe(
      0,
    );

    const before = await run([
      "functions",
      "list",
      "--output",
      "json",
      "--project-ref",
      projectRef,
    ]);
    expect(before.exitCode, before.stderr).toBe(0);
    expect(activeSlugs(before.stdout)).toContain(slug);

    const del = await run(["functions", "delete", slug, "--project-ref", projectRef]);
    expect(del.exitCode, del.stderr).toBe(0);
    expect(del.stdout).toContain("Deleted Function");

    const after = await run(["functions", "list", "--output", "json", "--project-ref", projectRef]);
    expect(after.exitCode, after.stderr).toBe(0);
    expect(activeSlugs(after.stdout)).not.toContain(slug);
  });
});
