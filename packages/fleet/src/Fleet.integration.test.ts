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

    const a = await fleet.createPod({ id: "a", versions: { postgres: PG_VERSION } });
    expect(a.state).toBe("suspended");

    // First connection wakes the pod transparently.
    await query(a.dbUrl, "create table t(x int); insert into t values (1)");
    const warm = (await fleet.listPods()).find((p) => p.manifest.id === "a");
    expect(warm?.state).toBe("warm");

    // Idle out (no connections) -> suspended.
    await new Promise((r) => setTimeout(r, 4000));
    const idle = (await fleet.listPods()).find((p) => p.manifest.id === "a");
    expect(idle?.state).toBe("suspended");

    // Wake again on the SAME dbUrl; data survived suspend.
    expect(await query(a.dbUrl, "select x from t")).toContain("1");

    // Fork inherits data, diverges independently.
    const b = await fleet.forkPod("a", "b");
    await query(b.dbUrl, "insert into t values (2)");
    expect(await query(a.dbUrl, "select count(*)::int as n from t")).toContain("1");
    expect(await query(b.dbUrl, "select count(*)::int as n from t")).toContain("2");
  }, 600_000);
});
