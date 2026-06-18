import { Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  legacyBuildEdgeRuntimeEntrypoint,
  legacyBuildEdgeRuntimeStartCmd,
} from "./legacy-edge-runtime-script.service.ts";

describe("legacyBuildEdgeRuntimeStartCmd", () => {
  it("includes --port when a free port was allocated", () => {
    expect(legacyBuildEdgeRuntimeStartCmd({ port: Option.some(54123), debug: false })).toEqual([
      "edge-runtime",
      "start",
      "--main-service=.",
      "--port=54123",
    ]);
  });

  it("drops --port when allocation failed (Go preserves prior behaviour)", () => {
    expect(legacyBuildEdgeRuntimeStartCmd({ port: Option.none(), debug: false })).toEqual([
      "edge-runtime",
      "start",
      "--main-service=.",
    ]);
  });

  it("appends --verbose after --port under --debug", () => {
    expect(legacyBuildEdgeRuntimeStartCmd({ port: Option.some(5), debug: true })).toEqual([
      "edge-runtime",
      "start",
      "--main-service=.",
      "--port=5",
      "--verbose",
    ]);
  });
});

describe("legacyBuildEdgeRuntimeEntrypoint", () => {
  it("returns just the command (newline-terminated) when there are no files", () => {
    expect(legacyBuildEdgeRuntimeEntrypoint([], "edge-runtime start")).toBe("edge-runtime start\n");
  });

  it("writes a single file via a sentinel here-document then runs the command", () => {
    const out = legacyBuildEdgeRuntimeEntrypoint(
      [{ name: "index.ts", content: "console.log(1);" }],
      "edge-runtime start --main-service=. --port=5",
    );
    // Byte-for-byte port of Go's buildEdgeRuntimeEntrypoint: openers (joined with
    // ` && `) precede the command, then the bodies with their sentinels.
    expect(out).toBe(
      "cat <<'__EDGE_RT_FILE_0__' > index.ts && edge-runtime start --main-service=. --port=5\n" +
        "console.log(1);\n__EDGE_RT_FILE_0__\n",
    );
  });

  it("stacks multiple files in declaration order with unique sentinels", () => {
    const out = legacyBuildEdgeRuntimeEntrypoint(
      [
        { name: "index.ts", content: "A" },
        { name: ".npmrc", content: "B" },
      ],
      "CMD",
    );
    expect(out).toBe(
      "cat <<'__EDGE_RT_FILE_0__' > index.ts && cat <<'__EDGE_RT_FILE_1__' > .npmrc && CMD\n" +
        "A\n__EDGE_RT_FILE_0__\nB\n__EDGE_RT_FILE_1__\n",
    );
  });

  it("preserves file contents that themselves contain EOF-like text", () => {
    const out = legacyBuildEdgeRuntimeEntrypoint([{ name: "index.ts", content: "EOF\nmore" }], "C");
    expect(out).toBe("cat <<'__EDGE_RT_FILE_0__' > index.ts && C\nEOF\nmore\n__EDGE_RT_FILE_0__\n");
  });
});
