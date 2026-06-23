import { describe, expect, it } from "vitest";

import {
  legacyResolveDeclarativeMigrationName,
  legacyResolveDeclarativeSyncApplyDecision,
} from "./declarative.flow.ts";

describe("legacyResolveDeclarativeMigrationName", () => {
  it("prefers an explicit --name over --file", () => {
    expect(legacyResolveDeclarativeMigrationName("my_change", "declarative_sync")).toBe(
      "my_change",
    );
  });

  it("falls back to --file when --name is empty", () => {
    expect(legacyResolveDeclarativeMigrationName("", "declarative_sync")).toBe("declarative_sync");
  });
});

describe("legacyResolveDeclarativeSyncApplyDecision", () => {
  const base = { apply: false, noApply: false, yes: false, tty: false };

  it("skips when --no-apply is set, regardless of other flags", () => {
    expect(
      legacyResolveDeclarativeSyncApplyDecision({
        apply: true,
        noApply: true,
        yes: true,
        tty: true,
      }),
    ).toBe("skip");
  });

  it("applies when --apply is set (and --no-apply is not)", () => {
    expect(
      legacyResolveDeclarativeSyncApplyDecision({ ...base, apply: true, yes: false, tty: false }),
    ).toBe("apply");
  });

  it("applies when global --yes is set", () => {
    expect(legacyResolveDeclarativeSyncApplyDecision({ ...base, yes: true })).toBe("apply");
  });

  it("prompts when on a TTY and no apply flags are set", () => {
    expect(legacyResolveDeclarativeSyncApplyDecision({ ...base, tty: true })).toBe("prompt");
  });

  it("skips in non-interactive mode with no apply flags", () => {
    expect(legacyResolveDeclarativeSyncApplyDecision(base)).toBe("skip");
  });
});
