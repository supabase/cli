import { describe, expect, it } from "vitest";
import { makeVectorServiceNative } from "./vector.ts";

describe("makeVectorServiceNative", () => {
  it("launches the published binary with a private generated config and loopback health", () => {
    const def = makeVectorServiceNative({
      binPath: "/cache/vector/0.53.0/darwin-arm64",
      runtimeRoot: "/tmp/stacks/project-a/runtime",
      adminPort: 54333,
      analyticsPort: 54327,
      analyticsApiKey: "analytics-key",
      dependencies: [{ service: "analytics", condition: "healthy" }],
    });

    expect(def).toMatchObject({
      name: "vector",
      command: "/cache/vector/0.53.0/darwin-arm64/bin/vector",
      args: ["--config", "/tmp/stacks/project-a/runtime/vector/vector.yaml"],
      dependencies: [{ service: "analytics", condition: "healthy" }],
      restart: "unless-stopped",
    });
    expect(def.env).toEqual({ VECTOR_THREADS: "1" });
    expect(def.healthCheck?.probe).toEqual({
      _tag: "Http",
      host: "127.0.0.1",
      port: 54333,
      path: "/health",
      scheme: "http",
    });
  });
});
