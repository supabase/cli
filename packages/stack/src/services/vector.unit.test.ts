// oxlint-disable effecttsgo/async-function -- Tests intentionally exercise native async, HTTP, timer, and subprocess boundaries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stackIdentity } from "../StackIdentity.ts";
import { DEFAULT_VERSIONS, dockerImageForService } from "../versions.ts";
import { makeVectorServiceDocker } from "./vector.ts";

const existingPaths = vi.hoisted(() => new Set<string>());
const accessiblePaths = vi.hoisted(() => new Set<string>());

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => existingPaths.has(String(path)),
    accessSync: (path: Parameters<typeof actual.accessSync>[0]) => {
      const socket = String(path);
      if (!existingPaths.has(socket) || !accessiblePaths.has(socket)) {
        throw new Error("socket is not accessible");
      }
    },
  };
});

const identity = stackIdentity({ apiPort: 54321 });

const makeVector = (runtime: "docker" | "podman") =>
  makeVectorServiceDocker({
    runtime,
    image: dockerImageForService("vector", DEFAULT_VERSIONS.vector),
    identity,
    serviceHost: "127.0.0.1",
    analyticsPort: 54327,
    analyticsApiKey: "test-api-key",
    platformOs: "linux",
    dependencies: [],
  });

describe("makeVectorServiceDocker log source", () => {
  beforeEach(() => {
    existingPaths.clear();
    accessiblePaths.clear();
    vi.stubEnv("CONTAINER_HOST", "");
    vi.stubEnv("DOCKER_HOST", "");
    vi.stubEnv("XDG_RUNTIME_DIR", "");
  });

  afterEach(() => {
    existingPaths.clear();
    accessiblePaths.clear();
    vi.unstubAllEnvs();
  });

  it("uses internal_logs when Podman cannot find its own socket", () => {
    existingPaths.add("/var/run/docker.sock");
    accessiblePaths.add("/var/run/docker.sock");

    const def = makeVector("podman");
    const args = def.args ?? [];

    expect(args.join("\n")).toContain("type: internal_logs");
    expect(args).not.toContain("/var/run/docker.sock:/var/run/docker.sock:ro");
    expect(args).not.toContain("DOCKER_HOST=unix:///var/run/docker.sock");
    expect(def.env?.DOCKER_HOST).toBeUndefined();
    expect(args).not.toContain("--security-opt");
  });

  it("connects Podman Vector to an available Podman socket", () => {
    existingPaths.add("/run/podman/podman.sock");
    accessiblePaths.add("/run/podman/podman.sock");

    const def = makeVector("podman");
    const args = def.args ?? [];

    expect(args.join("\n")).toContain("type: docker_logs");
    expect(args).toContain("/run/podman/podman.sock:/var/run/docker.sock:ro");
    expect(def.env?.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
    expect(args).not.toContain("DOCKER_HOST=unix:///var/run/docker.sock");
    expect(args).toContain("--security-opt");
    expect(args).toContain("label=disable");
  });

  it("uses internal_logs when Docker cannot find its socket", () => {
    const def = makeVector("docker");
    const args = def.args ?? [];

    expect(args.join("\n")).toContain("type: internal_logs");
    expect(args).not.toContain("/var/run/docker.sock:/var/run/docker.sock:ro");
    expect(args).not.toContain("DOCKER_HOST=unix:///var/run/docker.sock");
    expect(def.env?.DOCKER_HOST).toBeUndefined();
    expect(args).not.toContain("--security-opt");
  });

  it("uses internal_logs when the Podman socket is not readable and writable", () => {
    existingPaths.add("/run/podman/podman.sock");

    const def = makeVector("podman");
    const args = def.args ?? [];

    expect(args.join("\n")).toContain("type: internal_logs");
    expect(args).not.toContain("/run/podman/podman.sock:/var/run/docker.sock:ro");
    expect(args).not.toContain("DOCKER_HOST=unix:///var/run/docker.sock");
    expect(def.env?.DOCKER_HOST).toBeUndefined();
    expect(args).not.toContain("--security-opt");
  });

  it("honors an explicit Docker socket for Podman Vector", () => {
    existingPaths.add("/var/run/docker.sock");
    accessiblePaths.add("/var/run/docker.sock");
    vi.stubEnv("DOCKER_HOST", "unix:///var/run/docker.sock");

    const def = makeVector("podman");
    const args = def.args ?? [];

    expect(args.join("\n")).toContain("type: docker_logs");
    expect(args).toContain("/var/run/docker.sock:/var/run/docker.sock:ro");
    expect(def.env?.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
    expect(args).not.toContain("DOCKER_HOST=unix:///var/run/docker.sock");
    expect(args).toContain("--security-opt");
    expect(args).toContain("label=disable");
  });
});
