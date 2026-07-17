import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFleet } from "./Fleet.ts";

const PG_VERSION = "17.6.1.143";

async function query(dbUrl: string, sql: string): Promise<string> {
  // Minimal client via Bun's built-in postgres support; this suite runs under Bun.
  const { SQL } = await import("bun");
  const db = new SQL(dbUrl);
  const rows = await db.unsafe(sql);
  await db.close();
  return JSON.stringify(rows);
}

describe.skipIf(!process.env.FLEET_PG_TESTS)("Fleet", () => {
  it("wake-on-connect, suspend-on-idle, fork", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-e2e-"));
    await using fleet = await createFleet({ root, idleMs: 2000 });

    const a = await fleet.createPod({ id: "a", postgresVersion: PG_VERSION });
    expect(a.state).toBe("suspended");

    // First connection wakes the pod transparently.
    await query(a.dbUrl, "create table t(x int); insert into t values (1)");
    const warm = (await fleet.listPods()).find((p) => p.id === "a");
    expect(warm?.state).toBe("warm");

    // Idle out (no connections) -> suspended.
    await new Promise((r) => setTimeout(r, 4000));
    const idle = (await fleet.listPods()).find((p) => p.id === "a");
    expect(idle?.state).toBe("suspended");

    // Wake again on the SAME dbUrl; data survived suspend.
    expect(await query(a.dbUrl, "select x from t")).toContain("1");

    // Fork inherits data, diverges independently.
    const b = await fleet.forkPod("a", "b");
    const sourceAfterFork = (await fleet.listPods()).find((p) => p.id === "a");
    expect(sourceAfterFork?.state).toBe("warm");
    await query(b.dbUrl, "insert into t values (2)");
    expect(await query(a.dbUrl, "select count(*)::int as n from t")).toContain("1");
    expect(await query(b.dbUrl, "select count(*)::int as n from t")).toContain("2");
  }, 600_000);

  it("serializes concurrent suspend/wake without corrupting the pod", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-e2e-"));
    await using fleet = await createFleet({ root, idleMs: 60_000 });

    const a = await fleet.createPod({ id: "a", postgresVersion: PG_VERSION });
    await query(a.dbUrl, "create table t(x int); insert into t values (1)");

    // Wake explicitly, then hammer it with interleaved suspend calls and
    // queries racing against each other. Queries may transiently fail as
    // connections drop out from under them mid-suspend — that's expected
    // and NOT asserted against — but the pod must never crash the fleet
    // process, and per-pod lifecycle ops must never interleave badly enough
    // to corrupt the data dir or leave the pod stuck in a bad state.
    await fleet.wake("a");

    const attempts = await Promise.allSettled([
      fleet.suspend("a"),
      query(a.dbUrl, "select x from t"),
      fleet.suspend("a"),
      query(a.dbUrl, "select x from t"),
      fleet.wake("a"),
      fleet.suspend("a"),
      query(a.dbUrl, "select x from t"),
    ]);
    // No assertions on individual outcomes: the point is none of this threw
    // an unhandled exception past allSettled (i.e. the fleet process didn't
    // crash) and that whatever state we land in is still usable below.
    expect(attempts.length).toBe(7);

    // Whatever transient state the interleaving left the pod in, a final
    // query must succeed and see the original data intact (wake-on-connect
    // recovers a suspended pod; a warm pod just answers directly).
    expect(await query(a.dbUrl, "select x from t")).toContain("1");

    const final = (await fleet.listPods()).find((p) => p.id === "a");
    expect(["warm", "suspended"]).toContain(final?.state);
  }, 600_000);
});
