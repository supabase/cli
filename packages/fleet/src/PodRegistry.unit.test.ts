import { mkdtemp } from "node:fs/promises";
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
});
