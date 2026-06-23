import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildServeEntrypointScript, stripServeMainTypecheckPreamble } from "./serve.ts";

const serveMainSource = readFileSync(
  fileURLToPath(new URL("./serve.main.ts", import.meta.url)),
  "utf8",
);

describe("stripServeMainTypecheckPreamble", () => {
  it("removes the @ts-nocheck pragma and ambient declare shims", () => {
    const source = [
      "// @ts-nocheck",
      "declare const Deno: any;",
      "declare const EdgeRuntime: any;",
      "",
      'import { foo } from "https://example.com/foo.ts";',
      "const x = 1;",
    ].join("\n");

    expect(stripServeMainTypecheckPreamble(source)).toBe(
      ['import { foo } from "https://example.com/foo.ts";', "const x = 1;"].join("\n"),
    );
  });

  it("leaves a template that has no preamble untouched", () => {
    const source = ['import { foo } from "x";', "const x = 1;"].join("\n");
    expect(stripServeMainTypecheckPreamble(source)).toBe(source);
  });

  it("strips the real serve.main.ts down to its first import, matching the Go template head", () => {
    const stripped = stripServeMainTypecheckPreamble(serveMainSource);
    expect(stripped.startsWith("import ")).toBe(true);
    expect(stripped).not.toContain("@ts-nocheck");
    expect(stripped).not.toContain("declare const Deno");
    expect(stripped).not.toContain("declare const EdgeRuntime");
  });
});

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

  it("does not let the real serve.main.ts template close the heredoc early", () => {
    expect(serveMainSource.split("\n")).not.toContain("EOF");
    expect(() =>
      buildServeEntrypointScript(stripServeMainTypecheckPreamble(serveMainSource), [
        "edge-runtime",
        "start",
      ]),
    ).not.toThrow();
  });
});
