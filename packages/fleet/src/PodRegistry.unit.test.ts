import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
      warm: false,
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

  it("rejects manifests whose ports drifted out of their fleet ranges", async () => {
    const root = await mkdtemp(join(tmpdir(), "pods-"));
    const pods = new PodRegistry(root);
    const base = {
      versions: { postgres: "17.6.1.143" },
      services: {},
      flags: { supautils: false },
      warm: false,
      postgresPassword: "postgres",
      createdAt: "2026-07-08T00:00:00.000Z",
    };

    // Internal ports in the public proxy range: wake would bind postgres on a
    // proxy-owned port.
    await mkdir(join(root, "bad-internal"));
    await writeFile(
      join(root, "bad-internal", "pod.json"),
      JSON.stringify({
        ...base,
        id: "bad-internal",
        ports: ports(55000, 55001),
        internalPorts: ports(55100, 55101),
      }),
    );
    // Public ports below the proxy range.
    await mkdir(join(root, "bad-public"));
    await writeFile(
      join(root, "bad-public", "pod.json"),
      JSON.stringify({
        ...base,
        id: "bad-public",
        ports: ports(45000, 45001),
        internalPorts: ports(46000, 46001),
      }),
    );

    await expect(pods.read("bad-internal")).resolves.toBeUndefined();
    await expect(pods.read("bad-public")).resolves.toBeUndefined();
    await expect(pods.list()).resolves.toEqual([]);
  });

  it("rejects manifests with duplicate ports and non-directory pod entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pods-"));
    const pods = new PodRegistry(root);
    const duplicated = ports(55000, 55001);

    await mkdir(join(root, "dup-ports"));
    await writeFile(
      join(root, "dup-ports", "pod.json"),
      JSON.stringify({
        id: "dup-ports",
        versions: { postgres: "17.6.1.143" },
        services: {},
        flags: { supautils: false },
        warm: false,
        ports: { ...duplicated, apiPort: duplicated.dbPort },
        internalPorts: ports(45000, 45001),
        postgresPassword: "postgres",
        createdAt: "2026-07-08T00:00:00.000Z",
      }),
    );
    // A stray regular file matching the id regex must not surface as a pod id.
    await writeFile(join(root, "not-a-pod"), "just a file");

    await expect(pods.read("dup-ports")).resolves.toBeUndefined();
    await expect(pods.listIds()).resolves.toEqual(["dup-ports"]);
    await expect(pods.list()).resolves.toEqual([]);
  });

  it("propagates pod-root scan failures instead of reporting an empty fleet", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores modes
    const root = await mkdtemp(join(tmpdir(), "pods-"));
    const pods = new PodRegistry(root);
    try {
      await chmod(root, 0o000);
      // Treating EACCES as "no pods" would let startup free every port
      // reservation while pod dirs still exist behind the unreadable root.
      await expect(pods.listIds()).rejects.toThrow();
    } finally {
      await chmod(root, 0o700);
    }
    // A genuinely missing root still means "no pods".
    const missing = new PodRegistry(join(root, "does-not-exist"));
    await expect(missing.listIds()).resolves.toEqual([]);
  });

  it("rejects manifests missing versions for postgres or enabled services", async () => {
    const root = await mkdtemp(join(tmpdir(), "pods-"));
    const pods = new PodRegistry(root);
    const base = {
      services: {},
      flags: { supautils: false },
      warm: false,
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
