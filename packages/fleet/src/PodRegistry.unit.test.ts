import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PodRegistry } from "./PodRegistry.ts";

describe("PodRegistry", () => {
  it("rejects ids that could escape the pod root", async () => {
    const pods = new PodRegistry(await mkdtemp(join(tmpdir(), "pods-")));

    expect(() => pods.podDir("../templates")).toThrow(/invalid pod id/);
    expect(() => pods.dataDir("nested/pod")).toThrow(/invalid pod id/);
    expect(() => pods.podDir("pod-a")).not.toThrow();
  });

  it("ignores non-pod entries while listing persisted pods", async () => {
    const root = await mkdtemp(join(tmpdir(), "pods-"));
    const pods = new PodRegistry(root);
    const manifest = {
      id: "pod-a",
      versions: { postgres: "17.6.1.143" },
      services: {},
      flags: { supautils: false },
      ports: { dbPort: 55000, apiPort: 55001 },
      createdAt: "2026-07-08T00:00:00.000Z",
    };

    await pods.write(manifest);
    await writeFile(join(root, ".DS_Store"), "not a pod");

    await expect(pods.list()).resolves.toEqual([manifest]);
  });
});
