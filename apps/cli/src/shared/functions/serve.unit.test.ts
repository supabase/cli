import { describe, expect, it } from "vitest";

import { bundleServeMainTemplate } from "./serve-main-bundler.ts";
import { buildServeEntrypointScript } from "./serve.ts";

describe("buildServeEntrypointScript", () => {
  const template = ['import { x } from "y";', "Deno.serve(() => new Response());"].join("\n");

  it("writes the template through the heredoc and appends the runtime command", () => {
    const script = buildServeEntrypointScript(template, ["edge-runtime", "start"]);
    expect(script).toContain("cat <<'EOF' > /root/index.ts");
    expect(script).toContain(template);
    expect(script).toContain("edge-runtime start");
    expect(script).not.toContain(". /");
  });

  it("sources the multiline env script before the runtime command when provided", () => {
    const script = buildServeEntrypointScript(template, ["edge-runtime", "start"], "/root/env.sh");
    expect(script).toContain(". /root/env.sh\nedge-runtime start");
  });

  it("fails loudly when the template contains a bare heredoc terminator line", () => {
    const poisoned = ["line-1", "EOF", "line-3"].join("\n");
    expect(() => buildServeEntrypointScript(poisoned, ["edge-runtime", "start"])).toThrow(
      'heredoc terminator "EOF"',
    );
  });

  it("does not let the real bundled serve.main.ts template close the heredoc early", async () => {
    const bundled = await bundleServeMainTemplate();
    expect(bundled.split("\n")).not.toContain("EOF");
    expect(() => buildServeEntrypointScript(bundled, ["edge-runtime", "start"])).not.toThrow();
  });
});
