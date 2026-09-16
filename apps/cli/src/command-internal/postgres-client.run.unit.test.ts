import { describe, expect, it } from "@effect/vitest";

import {
  rewriteDumpHostForToolContainer,
  toolContainerUsesHostNetwork,
} from "./postgres-client.run.ts";
import { bundledPostgresClientRuntime } from "./bundled-postgres-client.ts";

describe("toolContainerUsesHostNetwork", () => {
  it("treats an omitted or Docker host network as the host netns", () => {
    expect(toolContainerUsesHostNetwork(undefined)).toBe(true);
    expect(toolContainerUsesHostNetwork("")).toBe(true);
    expect(toolContainerUsesHostNetwork("host")).toBe(true);
    expect(toolContainerUsesHostNetwork("custom_net")).toBe(false);
  });
});

describe("rewriteDumpHostForToolContainer", () => {
  it("keeps loopback on Linux host networking", () => {
    expect(
      rewriteDumpHostForToolContainer("127.0.0.1", { platform: "linux", usesHostNetwork: true }),
    ).toBe("127.0.0.1");
  });

  it("rewrites loopback when the tool is not on the host netns", () => {
    expect(
      rewriteDumpHostForToolContainer("127.0.0.1", { platform: "linux", usesHostNetwork: false }),
    ).toBe("host.docker.internal");
  });
});

describe("bundledPostgresClientRuntime", () => {
  it("keeps a unix native stack on the native client", () => {
    expect(bundledPostgresClientRuntime({ kind: "native" }, "darwin")).toEqual({ kind: "native" });
  });

  it("forces a container client for Windows native stacks", () => {
    expect(bundledPostgresClientRuntime({ kind: "native" }, "win32")).toEqual({
      kind: "container",
      engine: "docker",
    });
  });
});
