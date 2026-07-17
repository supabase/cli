import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PodManifest } from "./PodManifest.ts";
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
      warm: false,
      dbPort: 55000,
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

  it("rejects manifests whose database port is outside the fleet range", async () => {
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

    await mkdir(join(root, "bad-public"));
    await writeFile(
      join(root, "bad-public", "pod.json"),
      JSON.stringify({
        ...base,
        id: "bad-public",
        dbPort: 45000,
      }),
    );

    await expect(pods.read("bad-public")).resolves.toBeUndefined();
    await expect(pods.list()).resolves.toEqual([]);
  });

  it("ignores non-directory pod entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pods-"));
    const pods = new PodRegistry(root);
    // A stray regular file matching the id regex must not surface as a pod id.
    await writeFile(join(root, "not-a-pod"), "just a file");

    await expect(pods.listIds()).resolves.toEqual([]);
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

  it("propagates lookup failures instead of treating an unreadable pod as absent", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores modes
    const root = await mkdtemp(join(tmpdir(), "pods-"));
    const pods = new PodRegistry(root);
    await mkdir(join(root, "pod-a"));
    try {
      await chmod(root, 0o000);
      await expect(pods.exists("pod-a")).rejects.toThrow();
      await expect(pods.read("pod-a")).rejects.toThrow();
    } finally {
      await chmod(root, 0o700);
    }
  });

  it("refuses to persist manifests that cannot be read back", async () => {
    const root = await mkdtemp(join(tmpdir(), "pods-"));
    const pods = new PodRegistry(root);
    const invalid = {
      id: "pod-a",
      versions: {},
      services: {},
      flags: { supautils: false },
      warm: false,
      dbPort: 55000,
      postgresPassword: "postgres",
      createdAt: "2026-07-08T00:00:00.000Z",
    };

    await expect(pods.write(invalid as unknown as PodManifest)).rejects.toThrow(
      "invalid pod manifest",
    );
    await expect(pods.exists("pod-a")).resolves.toBe(false);
  });

  it("rejects manifests missing versions for postgres or enabled services", async () => {
    const root = await mkdtemp(join(tmpdir(), "pods-"));
    const pods = new PodRegistry(root);
    const base = {
      services: {},
      flags: { supautils: false },
      warm: false,
      dbPort: 55000,
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
