import { writeFile } from "node:fs/promises";
import path from "node:path";

import { expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../tests/helpers/live.ts";

const CLEANUP_EXIT_TIMEOUT_MS = 120_000;

// Golden path only: a sparse config.toml declaring one property round-trips
// through push, `config diff` proves convergence, and the restore push is
// re-proven the same way (push exits 0 on "Nothing to push", so exit code
// alone cannot tell a restore from a silent no-op). Branch coverage lives in
// push.integration.test.ts.
test("pushes one declared property, diff proves it landed, and a restore push puts the captured value back", async ({
  cli,
  project,
  workspace,
}) => {
  const writeConfig = (maxRows: number) =>
    writeFile(
      path.join(workspace.path, "supabase", "config.toml"),
      `project_id = "cli-live-config-push"\n\n[api]\nmax_rows = ${maxRows}\n`,
    );
  const diffMaxRows = async (label: string, exitTimeoutMs?: number) => {
    const result = await cli(
      ["config", "diff", "--project-ref", project.ref, "--output-format", "json"],
      { exitTimeoutMs },
    );
    requireLiveSuccess(result, label);
    let changes: Array<{ path: string[]; remote?: unknown }>;
    try {
      ({ changes } = JSON.parse(result.stdout) as {
        changes: Array<{ path: string[]; remote?: unknown }>;
      });
      changes = changes.filter((change) => change.path.join(".") === "api.max_rows");
    } catch {
      throw new Error(`${label}: unexpected config diff payload\n${result.stdout}`);
    }
    return { entries: changes, stdout: result.stdout };
  };

  // No diff entry means the remote already reads the probe value.
  await writeConfig(777);
  const capturedEntry = (await diffMaxRows("config diff capture")).entries[0];
  const captured = capturedEntry === undefined ? 777 : capturedEntry.remote;
  // A non-positive value is dropped from the local projection, which would
  // make the restore push a silent no-op — abort before any mutation.
  if (typeof captured !== "number" || !Number.isSafeInteger(captured) || captured <= 0) {
    throw new Error(`unexpected api.max_rows capture: ${JSON.stringify(capturedEntry)}`);
  }
  const changed = captured === 777 ? 778 : 777;

  let targetError: unknown;
  const cleanupErrors: Array<unknown> = [];
  try {
    await writeConfig(changed);
    const pushed = await cli([
      "config",
      "push",
      "--project-ref",
      project.ref,
      "--yes",
      "--output-format",
      "json",
    ]);
    requireLiveSuccess(pushed, "config push");
    const payload = JSON.parse(pushed.stdout) as {
      message?: unknown;
      services?: Array<{ service?: unknown; status?: unknown; changes?: unknown }>;
    };
    expect(payload, pushed.stdout).toEqual(expect.objectContaining({ project_ref: project.ref }));
    expect(
      (payload.services ?? []).filter((service) => service.status === "updated"),
      pushed.stdout,
    ).toEqual([expect.objectContaining({ service: "api", changes: [["api", "max_rows"]] })]);
    expect(payload.message, pushed.stdout).toContain(`1 property pushed to ${project.ref}.`);

    const proof = await diffMaxRows("config diff proof");
    expect(proof.entries, proof.stdout).toEqual([]);
  } catch (error) {
    targetError = error;
  } finally {
    try {
      await writeConfig(captured);
      const restored = await cli(
        ["config", "push", "--project-ref", project.ref, "--yes", "--output-format", "json"],
        { exitTimeoutMs: CLEANUP_EXIT_TIMEOUT_MS },
      );
      requireLiveSuccess(restored, "config push restore of the captured value");
      const restoreProof = await diffMaxRows(
        "config diff proof of the restored value",
        CLEANUP_EXIT_TIMEOUT_MS,
      );
      expect(restoreProof.entries, restoreProof.stdout).toEqual([]);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  throwWithCleanup(targetError, cleanupErrors);
});
