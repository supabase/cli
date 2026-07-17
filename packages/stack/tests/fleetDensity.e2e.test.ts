import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFleet } from "../src/fleet/index.ts";

const PG_VERSION = "17.6.1.143";
const REGISTERED = Number(process.env.FLEET_E2E_PODS ?? 20); // 100+ locally, 20 in CI
const WARM = 3;

describe.skipIf(!process.env.FLEET_PG_TESTS)("fleet density", () => {
  it(`registers ${REGISTERED} pods, wakes ${WARM}, suspends cleanly`, async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-density-"));
    await using fleet = await createFleet({ root, idleMs: 60_000 });

    // Registration is cheap: template built once, then CoW clones.
    for (let i = 0; i < REGISTERED; i += 1) {
      await fleet.createPod({
        id: `pod-${i}`,
        versions: { postgres: PG_VERSION },
        services: [],
        warmTemplate: false,
        start: false,
      });
    }
    const all = await fleet.listPods();
    expect(all).toHaveLength(REGISTERED);
    expect(all.every((p) => p.state === "suspended")).toBe(true);

    // Distinct external ports across the whole fleet.
    const portSet = new Set(all.map((p) => new URL(p.dbUrl).port));
    expect(portSet.size).toBe(REGISTERED);

    // Wake a subset; the rest stay suspended (zero processes).
    for (let i = 0; i < WARM; i += 1) await fleet.wake(`pod-${i}`);
    const after = await fleet.listPods();
    expect(after.filter((p) => p.state === "warm")).toHaveLength(WARM);
    expect(after.filter((p) => p.state === "suspended")).toHaveLength(REGISTERED - WARM);

    // Explicit suspend brings a pod back to zero.
    await fleet.suspend("pod-0");
    const final = await fleet.listPods();
    expect(final.find((p) => p.id === "pod-0")?.state).toBe("suspended");
  }, 900_000);
});
