import { writeFile } from "node:fs/promises";
import path from "node:path";

import { expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../tests/helpers/live.ts";

// Two polled proofs push the worst case past the live testTimeout.
const PUSH_EXIT_TIMEOUT_MS = 75_000;
const DIFF_EXIT_TIMEOUT_MS = 20_000;
const LIVE_TIMEOUT_MS = 600_000;

// Golden path only: a sparse config.toml declaring one property round-trips through push,
// `config diff` proves convergence, and the restore push is re-proven the same way, since push
// exits 0 on "Nothing to push" too. Branch coverage lives in push.integration.test.ts.
test(
  "pushes one declared property, diff proves it landed, and a restore push puts the captured value back",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ cli, project, workspace }) => {
    const writeConfig = (maxRows: number) =>
      writeFile(
        path.join(workspace.path, "supabase", "config.toml"),
        `project_id = "cli-live-config-push"\n\n[api]\nmax_rows = ${maxRows}\n`,
      );
    const diffMaxRows = async (label: string) => {
      const result = await cli(
        ["config", "diff", "--project-ref", project.ref, "--output-format", "json"],
        { exitTimeoutMs: DIFF_EXIT_TIMEOUT_MS },
      );
      requireLiveSuccess(result, label);
      try {
        const { changes } = JSON.parse(result.stdout) as {
          changes: Array<{ path: string[]; remote?: unknown }>;
        };
        return changes.filter((change) => change.path.join(".") === "api.max_rows");
      } catch (error) {
        throw new Error(
          `${label}: unexpected config diff payload (${String(error)})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
      }
    };
    // A diff right after a push can read the previous value, so proofs poll until it converges.
    const expectMaxRowsConverged = (label: string) =>
      expect
        .poll(() => diffMaxRows(label), { interval: 2_000, timeout: 60_000, message: label })
        .toEqual([]);

    // No diff entry means the remote already reads the probe value.
    await writeConfig(777);
    const capturedEntry = (await diffMaxRows("config diff capture"))[0];
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
      const pushed = await cli(
        ["config", "push", "--project-ref", project.ref, "--yes", "--output-format", "json"],
        { exitTimeoutMs: PUSH_EXIT_TIMEOUT_MS },
      );
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

      await expectMaxRowsConverged("config diff proof");
    } catch (error) {
      targetError = error;
    } finally {
      try {
        await writeConfig(captured);
        const restored = await cli(
          ["config", "push", "--project-ref", project.ref, "--yes", "--output-format", "json"],
          { exitTimeoutMs: PUSH_EXIT_TIMEOUT_MS },
        );
        requireLiveSuccess(restored, "config push restore of the captured value");
        await expectMaxRowsConverged("config diff proof of the restored value");
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    throwWithCleanup(targetError, cleanupErrors);
  },
);
