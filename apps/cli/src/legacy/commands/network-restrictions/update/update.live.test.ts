import { Schema } from "effect";
import { expect } from "vitest";

import {
  experimentalProjectLiveFlags,
  type LiveFixtures,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../../tests/helpers/live.ts";

type LiveCli = LiveFixtures["cli"];

// Every subprocess is bounded so the capture, the update, both proofs and the
// restore fit inside the live testTimeout even when one command hangs: once a
// test has timed out its fixtures are disposed, so a late restore cannot take
// effect and the shared project stays locked down.
const EXIT_TIMEOUT_MS = 60_000;
const POLL_ATTEMPT_EXIT_TIMEOUT_MS = 20_000;

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

const NetworkRestrictions = Schema.Struct({
  config: Schema.Struct({
    dbAllowedCidrs: Schema.optionalKey(Schema.Array(Schema.String)),
    dbAllowedCidrsV6: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  status: Schema.Literals(["stored", "applied"]),
});

interface Posture {
  readonly cidrs: AllowedCidrs;
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

// A family the platform leaves absent has nothing to restore, so it reads as
// `[]` like an explicitly empty one.
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
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    payload = undefined;
  }
  if (!Schema.is(NetworkRestrictions)(payload)) {
    throw new Error(
      `${label}: unexpected network-restrictions get payload\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return {
    cidrs: {
      v4: payload.config.dbAllowedCidrs ?? [],
      v6: payload.config.dbAllowedCidrsV6 ?? [],
    },
    applied: payload.status === "applied",
  };
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
    .poll(() => readPosture(cli, flags, label, POLL_ATTEMPT_EXIT_TIMEOUT_MS), {
      interval: 2_000,
      timeout: 60_000,
      message: label,
    })
    .toEqual({ cidrs, applied: true });
}

test("replaces the allowlist, get proves it, and restores the baseline allowlist", async ({
  cli,
  project,
}) => {
  const flags = experimentalProjectLiveFlags(project);
  const captured = (
    await readPosture(
      cli,
      flags,
      "network-restrictions get capture for network-restrictions update",
      EXIT_TIMEOUT_MS,
    )
  ).cidrs;
  // An empty allowlist is restrict-all on the platform, so an empty or absent
  // family is restored to allow-all rather than leaving the shared project
  // locked down for every later live test that reaches the database directly.
  const baselineCidrs: AllowedCidrs = {
    v4: captured.v4.length > 0 ? captured.v4 : ALLOW_ALL_CIDRS.v4,
    v6: captured.v6.length > 0 ? captured.v6 : ALLOW_ALL_CIDRS.v6,
  };
  let targetError: unknown;
  const cleanupErrors: Array<unknown> = [];
  try {
    const updated = await cli([...updateArgs(TEST_CIDRS, flags), "-o", "json"], {
      exitTimeoutMs: EXIT_TIMEOUT_MS,
    });
    expect(updated.exitCode, updated.stderr).toBe(0);
    expect(updated.stdout, updated.stderr).not.toBe("");
    expect(JSON.parse(updated.stdout), updated.stdout).toMatchObject({
      config: { dbAllowedCidrs: TEST_CIDRS.v4, dbAllowedCidrsV6: TEST_CIDRS.v6 },
    });

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
      const restored = await cli(updateArgs(baselineCidrs, flags), {
        exitTimeoutMs: EXIT_TIMEOUT_MS,
      });
      requireLiveSuccess(restored, "network-restrictions update restore of the baseline allowlist");
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
});
