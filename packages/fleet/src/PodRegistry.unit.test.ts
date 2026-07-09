import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AllocatedPorts } from "@supabase/stack";
import { PodRegistry } from "./PodRegistry.ts";

function ports(dbPort: number, apiPort: number): AllocatedPorts {
  return {
    dbPort,
    apiPort,
    authPort: apiPort + 1,
    postgrestPort: apiPort + 2,
    postgrestAdminPort: apiPort + 3,
    edgeRuntimePort: apiPort + 4,
    edgeRuntimeInspectorPort: apiPort + 5,
    realtimePort: apiPort + 6,
    storagePort: apiPort + 7,
    imgproxyPort: apiPort + 8,
    mailpitPort: apiPort + 9,
    mailpitSmtpPort: apiPort + 10,
    mailpitPop3Port: apiPort + 11,
    pgmetaPort: apiPort + 12,
    studioPort: apiPort + 13,
    analyticsPort: apiPort + 14,
    poolerPort: apiPort + 15,
    poolerApiPort: apiPort + 16,
  };
}

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
      ports: ports(55000, 55001),
      internalPorts: ports(45000, 45001),
      postgresPassword: "postgres",
      createdAt: "2026-07-08T00:00:00.000Z",
    };

    await pods.write(manifest);
    await writeFile(join(root, ".DS_Store"), "not a pod");

    await expect(pods.list()).resolves.toEqual([manifest]);
  });

  it("skips malformed manifests while listing persisted pods", async () => {
    const root = await mkdtemp(join(tmpdir(), "pods-"));
    const pods = new PodRegistry(root);
    await mkdir(join(root, "bad"));
    await writeFile(join(root, "bad", "pod.json"), "not-json");

    await expect(pods.read("bad")).resolves.toBeUndefined();
    await expect(pods.list()).resolves.toEqual([]);
  });

  it("rejects manifests missing versions for postgres or enabled services", async () => {
    const root = await mkdtemp(join(tmpdir(), "pods-"));
    const pods = new PodRegistry(root);
    const base = {
      services: {},
      flags: { supautils: false },
      ports: ports(55000, 55001),
      internalPorts: ports(45000, 45001),
      postgresPassword: "postgres",
      createdAt: "2026-07-08T00:00:00.000Z",
    };

    await mkdir(join(root, "no-postgres"));
    await writeFile(
      join(root, "no-postgres", "pod.json"),
      JSON.stringify({ ...base, id: "no-postgres", versions: {} }),
    );
    await mkdir(join(root, "no-auth-version"));
    await writeFile(
      join(root, "no-auth-version", "pod.json"),
      JSON.stringify({
        ...base,
        id: "no-auth-version",
        versions: { postgres: "17.6.1.143" },
        services: { auth: true },
      }),
    );

    await expect(pods.read("no-postgres")).resolves.toBeUndefined();
    await expect(pods.read("no-auth-version")).resolves.toBeUndefined();
    await expect(pods.list()).resolves.toEqual([]);
  });
});
