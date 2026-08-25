import { describe, expect, it } from "vitest";

import { bundleServeMainTemplate } from "./serve-main-bundler.ts";
import { buildServeEntrypointCommand } from "./serve.ts";

describe("buildServeEntrypointCommand", () => {
  it("returns the runtime command without embedding the template body", () => {
    const script = buildServeEntrypointCommand(["edge-runtime", "start"]);
    expect(script).toBe("edge-runtime start\n");
    expect(script).not.toContain("Deno.serve");
  });

  it("sources the multiline env script before the runtime command when provided", () => {
    const script = buildServeEntrypointCommand(["edge-runtime", "start"], "/root/env.sh");
    expect(script).toContain(". /root/env.sh\nedge-runtime start");
  });

  it("keeps the spawned command short even with the real bundled template", async () => {
    const bundled = await bundleServeMainTemplate();
    const script = buildServeEntrypointCommand(["edge-runtime", "start"]);
    expect(bundled.length).toBeGreaterThan(20_000);
    expect(script.length).toBeLessThan(128);
  });
});
