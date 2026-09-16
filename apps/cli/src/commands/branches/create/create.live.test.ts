import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import {
  awaitLiveBranch,
  awaitLiveBranchRemoved,
  requireLiveJson,
  removeLiveBranchByName,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

test("creates a preview branch", async ({ cli, cliEffect, project }) => {
  const name = `cli-e2e-create-${randomUUID().slice(0, 8)}`;
  let branchRef: string | undefined;
  let targetError: unknown;
  let cleanupError: unknown;
  try {
    const created = await cli([
      "branches",
      "create",
      name,
      "--project-ref",
      project.ref,
      "--output-format",
      "json",
    ]);
    expect(created.exitCode, created.stderr).toBe(0);
    const body = requireLiveJson(created, "branches create");
    if (typeof body === "object" && body !== null && "project_ref" in body) {
      const ref = body.project_ref;
      if (typeof ref === "string" && ref.length > 0) branchRef = ref;
    }
    expect(body).toMatchObject({
      message: "Created preview branch",
      project_ref: expect.any(String),
    });
    expect(branchRef).toBeDefined();
    await awaitLiveBranch(cliEffect, project, name);
  } catch (error) {
    targetError = error;
  } finally {
    try {
      if (branchRef !== undefined) await awaitLiveBranchRemoved(cliEffect, project, branchRef);
      else await removeLiveBranchByName(cliEffect, project, name);
    } catch (error) {
      cleanupError = error;
    }
  }
  throwWithCleanup(targetError, cleanupError === undefined ? [] : [cleanupError]);
});
