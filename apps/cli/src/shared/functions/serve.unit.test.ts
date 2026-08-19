import { describe, expect, it } from "vitest";

import { bundleServeMainTemplate } from "./serve-main-bundler.ts";
import { dockerBindContainerPath } from "./deploy.ts";
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

describe("dockerBindContainerPath", () => {
  it("takes the container side of a posix bind", () => {
    expect(
      dockerBindContainerPath("/home/u/p/supabase/functions:/home/u/p/supabase/functions:ro"),
    ).toBe("/home/u/p/supabase/functions");
  });

  it("takes the container side when the host path carries a Windows drive letter", () => {
    // `split(":")[1]` returns the host-path tail here, which silently dropped
    // `--workdir` for every Windows project that had functions.
    expect(
      dockerBindContainerPath(
        "C:\\Users\\u\\p\\supabase\\functions:/Users/u/p/supabase/functions:ro",
      ),
    ).toBe("/Users/u/p/supabase/functions");
  });

  it("strips the SELinux relabel suffix this file emits", () => {
    expect(dockerBindContainerPath("/tmp/x/multiline-env:/root/.supabase/multiline-env:ro,Z")).toBe(
      "/root/.supabase/multiline-env",
    );
  });

  it("takes the container side of a named-volume bind", () => {
    expect(dockerBindContainerPath("supabase_edge_runtime_x:/root/.cache/deno:rw")).toBe(
      "/root/.cache/deno",
    );
  });
});
