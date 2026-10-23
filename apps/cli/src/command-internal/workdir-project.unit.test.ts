import { describe, expect, it } from "vitest";

import { describeConfigParseError, missingProjectConfigMessage } from "./workdir-project.ts";

describe("missingProjectConfigMessage", () => {
  it("points at `supabase init` for a defaulted workdir", () => {
    // Pinned byte-for-byte: `diff.e2e.test.ts`/`pull.e2e.test.ts` assert this
    // exact string when run with no `--workdir`.
    expect(missingProjectConfigMessage({ workdir: "/repo/sub", explicitWorkdir: false })).toBe(
      "failed to read supabase/config.toml or supabase/config.json: file not found. Run `supabase init` to create one.",
    );
  });

  it("names the resolved path and never suggests `supabase init` for an explicit workdir", () => {
    const message = missingProjectConfigMessage({
      workdir: "/repo/sub",
      explicitWorkdir: true,
    });
    expect(message).toContain("/repo/sub");
    expect(message).toContain("--workdir/SUPABASE_WORKDIR");
    expect(message).not.toContain("supabase init");
  });

  it("sanitizes control characters out of an explicit workdir before interpolating it", () => {
    const message = missingProjectConfigMessage({
      workdir: "/repo/subevil",
      explicitWorkdir: true,
    });
    expect(message).not.toContain("");
  });
});

describe("describeConfigParseError", () => {
  it("names the failed file relative to the workdir", () => {
    expect(
      describeConfigParseError("/repo", {
        path: "/repo/supabase/config.toml",
        cause: new Error("unexpected end of input"),
      }),
    ).toBe("failed to parse supabase/config.toml: unexpected end of input");
  });

  it("keeps a path outside the workdir as given", () => {
    expect(
      describeConfigParseError("/repo", { path: "/elsewhere/config.json", cause: "bad json" }),
    ).toBe("failed to parse /elsewhere/config.json: bad json");
  });
});
