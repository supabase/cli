import { describe, expect, it } from "vitest";

import {
  buildFunctionsDockerRunArgs,
  localDockerId,
  resolveDockerNetworkMode,
} from "./functions-docker.ts";

describe("buildFunctionsDockerRunArgs", () => {
  it("assembles run/--rm, binds, network, env, labels, image, and container args in order", () => {
    const args = buildFunctionsDockerRunArgs({
      image: "supabase/edge-runtime:v1.2.3",
      projectId: "my-project",
      networkMode: "supabase_network_my-project",
      binds: ["/host/a:/container/a", "/host/b:/container/b"],
      env: ["FOO=bar", "BAZ=qux"],
      containerArgs: ["bundle", "--entrypoint", "index.ts"],
      platform: "darwin",
    });

    expect(args).toEqual([
      "run",
      "--rm",
      "-v",
      "/host/a:/container/a",
      "-v",
      "/host/b:/container/b",
      "--network",
      "supabase_network_my-project",
      "-e",
      "FOO=bar",
      "-e",
      "BAZ=qux",
      "--label",
      "com.supabase.cli.project=my-project",
      "--label",
      "com.docker.compose.project=my-project",
      "supabase/edge-runtime:v1.2.3",
      "bundle",
      "--entrypoint",
      "index.ts",
    ]);
  });

  it("omits --add-host on a non-linux platform", () => {
    const args = buildFunctionsDockerRunArgs({
      image: "img",
      projectId: "p",
      networkMode: "bridge",
      binds: [],
      containerArgs: [],
      platform: "darwin",
    });

    expect(args).not.toContain("--add-host");
  });

  it("inserts --add-host host.docker.internal:host-gateway between --network and the -e entries on linux", () => {
    const args = buildFunctionsDockerRunArgs({
      image: "img",
      projectId: "p",
      networkMode: "bridge",
      binds: [],
      env: ["FOO=bar"],
      containerArgs: [],
      platform: "linux",
    });

    const networkIndex = args.indexOf("--network");
    expect(args.slice(networkIndex, networkIndex + 6)).toEqual([
      "--network",
      "bridge",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-e",
      "FOO=bar",
    ]);
  });

  it("produces no -v flags for an empty binds array", () => {
    const args = buildFunctionsDockerRunArgs({
      image: "img",
      projectId: "p",
      networkMode: "bridge",
      binds: [],
      containerArgs: [],
      platform: "darwin",
    });

    expect(args).not.toContain("-v");
  });

  it("produces no -e flags when env is omitted", () => {
    const args = buildFunctionsDockerRunArgs({
      image: "img",
      projectId: "p",
      networkMode: "bridge",
      binds: [],
      containerArgs: [],
      platform: "darwin",
    });

    expect(args).not.toContain("-e");
  });

  it("preserves the input order of multiple binds and env entries", () => {
    const args = buildFunctionsDockerRunArgs({
      image: "img",
      projectId: "p",
      networkMode: "bridge",
      binds: ["/c:/c", "/a:/a", "/b:/b"],
      env: ["C=3", "A=1", "B=2"],
      containerArgs: [],
      platform: "darwin",
    });

    expect(args.slice(2, 8)).toEqual(["-v", "/c:/c", "-v", "/a:/a", "-v", "/b:/b"]);
    const networkIndex = args.indexOf("--network");
    expect(args.slice(networkIndex + 2, networkIndex + 8)).toEqual([
      "-e",
      "C=3",
      "-e",
      "A=1",
      "-e",
      "B=2",
    ]);
  });

  it("uses the exact projectId value in both labels, unsanitized", () => {
    const args = buildFunctionsDockerRunArgs({
      image: "img",
      projectId: "My Weird/Project!!",
      networkMode: "bridge",
      binds: [],
      containerArgs: [],
      platform: "darwin",
    });

    expect(args).toContain("--label");
    expect(args).toContain("com.supabase.cli.project=My Weird/Project!!");
    expect(args).toContain("com.docker.compose.project=My Weird/Project!!");
  });
});

describe("resolveDockerNetworkMode", () => {
  it("prefers the explicit flag over the env override when both are set", () => {
    expect(
      resolveDockerNetworkMode({
        explicit: "explicit-network",
        envOverride: "env-network",
        projectId: "my-project",
      }),
    ).toBe("explicit-network");
  });

  it("falls back to the env override when explicit is undefined", () => {
    expect(
      resolveDockerNetworkMode({
        explicit: undefined,
        envOverride: "env-network",
        projectId: "my-project",
      }),
    ).toBe("env-network");
  });

  it("treats an explicit empty flag (--network-id=) as skipping straight to the generated default, not the env override", () => {
    // Go parity: viper's Changed pflag wins over AutomaticEnv outright — an
    // explicit `--network-id=` never falls back to SUPABASE_NETWORK_ID, only
    // an OMITTED flag does.
    expect(
      resolveDockerNetworkMode({
        explicit: "",
        envOverride: "env-network",
        projectId: "my-project",
      }),
    ).toBe(localDockerId("network", "my-project"));
  });

  it("treats an empty env override as unset and falls through to the generated default", () => {
    expect(
      resolveDockerNetworkMode({
        explicit: undefined,
        envOverride: "",
        projectId: "my-project",
      }),
    ).toBe(localDockerId("network", "my-project"));
  });

  it("generates supabase_network_<sanitized-project-id> when both are unset", () => {
    const result = resolveDockerNetworkMode({
      explicit: undefined,
      envOverride: undefined,
      projectId: "my-project",
    });

    expect(result).toBe(localDockerId("network", "my-project"));
    expect(result).toBe("supabase_network_my-project");
  });
});
