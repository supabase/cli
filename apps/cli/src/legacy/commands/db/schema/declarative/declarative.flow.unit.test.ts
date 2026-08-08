import { describe, expect, it } from "vitest";

import {
  legacyClassifyDeclarativeCompatibilityGap,
  legacyExtensionDeclaration,
  legacyFormatStagedExportRecommendation,
  legacyResolveDeclarativeMigrationName,
  legacyResolveDeclarativeSyncApplyDecision,
} from "./declarative.flow.ts";

const removals = {
  extensions: ["pgcrypto", "uuid-ossp"],
  extensionIntents: [
    { extension: "pg_cron", intentKind: "job", key: "refresh download metrics" },
    { extension: "pgmq", intentKind: "queue", key: "emails" },
  ],
};

describe("legacyClassifyDeclarativeCompatibilityGap", () => {
  it("repairs only the known legacy-implicit extension set", () => {
    const gap = legacyClassifyDeclarativeCompatibilityGap({
      implementation: "next",
      manifestPresent: false,
      removals: { extensions: ["uuid-ossp", "pgcrypto", "pgcrypto"], extensionIntents: [] },
    });
    expect(gap).toEqual({
      repairableExtensions: ["pgcrypto", "uuid-ossp"],
      extensionIntents: [],
      ambiguousRemovals: [],
      recommendedAction: "repair-extensions",
    });
    expect(legacyExtensionDeclaration("uuid-ossp")).toBe(
      'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";',
    );
  });

  it("stages a next export for mixed or unknown extension removals", () => {
    const gap = legacyClassifyDeclarativeCompatibilityGap({
      implementation: "next",
      manifestPresent: false,
      removals: { extensions: ["pgcrypto", "postgis"], extensionIntents: [] },
    });
    expect(gap.repairableExtensions).toEqual(["pgcrypto"]);
    expect(gap.ambiguousRemovals).toEqual(["postgis"]);
    expect(gap.recommendedAction).toBe("stage-next-export");
  });

  it("stages a next export when extension intents are present", () => {
    const gap = legacyClassifyDeclarativeCompatibilityGap({
      implementation: "next",
      manifestPresent: false,
      removals,
    });
    expect(gap.recommendedAction).toBe("stage-next-export");
    expect(legacyFormatStagedExportRecommendation(gap)).toContain(
      "generate <target> --output supabase/database-next",
    );
  });

  it("is suppressed for next exports with a manifest", () => {
    expect(
      legacyClassifyDeclarativeCompatibilityGap({
        implementation: "next",
        manifestPresent: true,
        removals,
      }).recommendedAction,
    ).toBe("none");
  });

  it("is suppressed for the legacy engine and irrelevant removals", () => {
    expect(
      legacyClassifyDeclarativeCompatibilityGap({
        implementation: "legacy",
        manifestPresent: false,
        removals,
      }),
    ).toMatchObject({ recommendedAction: "none" });
    expect(
      legacyClassifyDeclarativeCompatibilityGap({
        implementation: "next",
        manifestPresent: false,
        removals: { extensions: [], extensionIntents: [] },
      }),
    ).toMatchObject({ recommendedAction: "none" });
  });
});

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
