import { describe, expect, it } from "vitest";

import { legacyMissingProjectConfigMessage } from "./legacy-workdir-project.ts";

describe("legacyMissingProjectConfigMessage", () => {
  it("points at `supabase init` for a defaulted workdir", () => {
    // Pinned byte-for-byte: `diff.e2e.test.ts`/`pull.e2e.test.ts` assert this
    // exact string when run with no `--workdir`.
    expect(
      legacyMissingProjectConfigMessage({ workdir: "/repo/sub", explicitWorkdir: false }),
    ).toBe(
      "failed to read supabase/config.toml or supabase/config.json: file not found. Run `supabase init` to create one.",
    );
  });

  it("names the resolved path and never suggests `supabase init` for an explicit workdir", () => {
    const message = legacyMissingProjectConfigMessage({
      workdir: "/repo/sub",
      explicitWorkdir: true,
    });
    expect(message).toContain("/repo/sub");
    expect(message).toContain("--workdir/SUPABASE_WORKDIR");
    expect(message).not.toContain("supabase init");
  });

  it("sanitizes control characters out of an explicit workdir before interpolating it", () => {
    const message = legacyMissingProjectConfigMessage({
      workdir: "/repo/subevil",
      explicitWorkdir: true,
    });
    expect(message).not.toContain("");
  });
});
