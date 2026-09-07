import { V1GetNetworkRestrictionsOutput } from "@supabase/api/effect";
import { Schema } from "effect";
import { expect } from "vitest";

import {
  experimentalProjectLiveFlags,
  type LiveFixtures,
  requireLiveJson,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../../tests/helpers/live.ts";

type LiveCli = LiveFixtures["cli"];
type LiveRun = Awaited<ReturnType<LiveCli>>;

// Every subprocess is bounded and the test's own timeout covers the longest
// path through them: four 60s commands (the restore is issued at most twice)
// plus two proof polls that can each run 102s (a 60s deadline that still
// finishes an in-flight 20s attempt, waits the 2s interval and runs one last
// 20s attempt), 444s in all, on top of the workspace fixture's own 60s init.
// The real bound this ceiling has to fit inside is the 20-minute Live E2E
// step budget that every serially-run live file shares.
// Once a test has timed out its fixtures are disposed, so a late restore
// cannot take effect and the shared project stays locked down.
const EXIT_TIMEOUT_MS = 60_000;
const POLL_ATTEMPT_EXIT_TIMEOUT_MS = 20_000;
const PROOF_TIMEOUT_MS = 60_000;
const PROOF_INTERVAL_MS = 2_000;
const LIVE_TIMEOUT_MS = 600_000;

interface AllowedCidrs {
  readonly v4: ReadonlyArray<string>;
  readonly v6: ReadonlyArray<string>;
}

// Documentation ranges (RFC 5737 TEST-NET-3, RFC 3849): public, so the local
// private-range check accepts them, and unroutable, so allowing them admits
// nobody while the project is restricted.
const TEST_CIDRS: AllowedCidrs = { v4: ["203.0.113.0/24"], v6: ["2001:db8::/32"] };

// The allow-all sentinels `config.toml` ships as the `db.network_restrictions`
// defaults; ADR 0022 treats them as the platform's unconfigured state.
const ALLOW_ALL_CIDRS: AllowedCidrs = { v4: ["0.0.0.0/0"], v6: ["::/0"] };

interface Posture {
  readonly cidrs: AllowedCidrs;
  readonly configured: boolean;
  readonly applied: boolean;
}

function updateArgs(cidrs: AllowedCidrs, flags: ReadonlyArray<string>): string[] {
  return [
    "network-restrictions",
    "update",
    ...[...cidrs.v4, ...cidrs.v6].flatMap((cidr) => ["--db-allow-cidr", cidr]),
    ...flags,
  ];
}

function describeAttempt(attempt: number, result: LiveRun): string {
  return `\nattempt ${attempt} (exit ${result.exitCode})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

// An absent family reads as `[]` like an explicitly empty one; `configured`
// records whether any family key was present, which is what separates a
// never-configured project from one explicitly locked down to block-all.
async function readPosture(
  cli: LiveCli,
  flags: ReadonlyArray<string>,
  label: string,
  exitTimeoutMs: number,
): Promise<Posture> {
  const result = await cli(["network-restrictions", "get", ...flags, "-o", "json"], {
    exitTimeoutMs,
  });
  requireLiveSuccess(result, label);
  const payload = requireLiveJson(result, label);
  if (!Schema.is(V1GetNetworkRestrictionsOutput)(payload)) {
    throw new Error(
      `${label}: unexpected network-restrictions get payload\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  const v4 = payload.config.dbAllowedCidrs;
  const v6 = payload.config.dbAllowedCidrsV6;
  return {
    cidrs: { v4: v4 ?? [], v6: v6 ?? [] },
    configured: v4 !== undefined || v6 !== undefined,
    applied: payload.status === "applied",
  };
}

function sortedCidrs(cidrs: AllowedCidrs): AllowedCidrs {
  return { v4: [...cidrs.v4].sort(), v6: [...cidrs.v6].sort() };
}

// get reports `status: "stored"` until a requested allowlist has propagated
// (see the `V1GetNetworkRestrictionsOutput` config annotation in
// packages/api), so proving an update or a restore means polling get until
// the requested allowlist is reported as applied.
function expectApplied(
  cli: LiveCli,
  flags: ReadonlyArray<string>,
  cidrs: AllowedCidrs,
  label: string,
): Promise<void> {
  return expect
    .poll(
      async () => {
        const posture = await readPosture(cli, flags, label, POLL_ATTEMPT_EXIT_TIMEOUT_MS);
        return { cidrs: sortedCidrs(posture.cidrs), applied: posture.applied };
      },
      {
        interval: PROOF_INTERVAL_MS,
        timeout: PROOF_TIMEOUT_MS,
        message: label,
      },
    )
    .toEqual({ cidrs: sortedCidrs(cidrs), applied: true });
}

test(
  "replaces the allowlist, get proves it, and restores the baseline allowlist",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ cli, project }) => {
    const flags = experimentalProjectLiveFlags(project);
    const captured = await readPosture(
      cli,
      flags,
      "network-restrictions get capture for network-restrictions update",
      EXIT_TIMEOUT_MS,
    );
    // A never-configured project (both family keys absent) has no allowlist to
    // post back, so that baseline is restored as allow-all rather than leaving
    // the shared project locked down for every later live test that reaches
    // the database directly. Any configured capture is restored as read — an
    // explicitly empty (block-all) allowlist or an absent family beside a
    // populated one included, since posting an empty family is restrict-all
    // and therefore a faithful restore.
    const baselineCidrs: AllowedCidrs = captured.configured ? captured.cidrs : ALLOW_ALL_CIDRS;
    let targetError: unknown;
    const cleanupErrors: Array<unknown> = [];
    try {
      const updated = await cli([...updateArgs(TEST_CIDRS, flags), "-o", "json"], {
        exitTimeoutMs: EXIT_TIMEOUT_MS,
      });
      expect(updated.exitCode, updated.stderr).toBe(0);
      expect(requireLiveJson(updated, "network-restrictions update"), updated.stdout).toMatchObject(
        { config: { dbAllowedCidrs: TEST_CIDRS.v4, dbAllowedCidrsV6: TEST_CIDRS.v6 } },
      );

      await expectApplied(
        cli,
        flags,
        TEST_CIDRS,
        "network-restrictions get proof for network-restrictions update",
      );
    } catch (error) {
      targetError = error;
    } finally {
      try {
        // One re-issue covers a restore that failed transiently. The proof runs
        // whatever the restore reported: it alone shows whether the allowlist
        // came back, and a restore killed while its request was still in flight
        // exits non-zero after the platform may already have applied it.
        const restore = () =>
          cli(updateArgs(baselineCidrs, flags), { exitTimeoutMs: EXIT_TIMEOUT_MS });
        const first = await restore();
        if (first.exitCode !== 0) {
          console.warn("network-restrictions update restore retrying" + describeAttempt(1, first));
        }
        const restored = first.exitCode === 0 ? first : await restore();
        if (restored.exitCode !== 0) {
          cleanupErrors.push(
            new Error(
              "network-restrictions update restore of the baseline allowlist failed twice" +
                describeAttempt(1, first) +
                describeAttempt(2, restored),
            ),
          );
        }
        await expectApplied(
          cli,
          flags,
          baselineCidrs,
          "network-restrictions get proof of the restored allowlist for network-restrictions update",
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    throwWithCleanup(targetError, cleanupErrors);
  },
);
