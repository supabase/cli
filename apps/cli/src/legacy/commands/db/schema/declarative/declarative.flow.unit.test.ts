import { describe, expect, it } from "vitest";

import {
  legacyClassifyDeclarativeCompatibilityGap,
  legacyClassifyDeclarativeLoadCompatibility,
  legacyExtensionDeclaration,
  legacyFormatStagedExportRecommendation,
  legacyResolveDeclarativeMigrationName,
  legacyResolveDeclarativeSyncApplyDecision,
} from "./declarative.flow.ts";

const stuck = (message: string) => ({
  code: "stuck_statement",
  severity: "error",
  message,
});

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
      "generate --local --overwrite \\\n    --output supabase/database-next --experimental",
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

describe("legacyClassifyDeclarativeLoadCompatibility", () => {
  it.each([
    ["extensions.uuid_generate_v4()", "uuid-ossp"],
    ["extensions.digest(text, text)", "pgcrypto"],
    ["extensions.crypt(text, text)", "pgcrypto"],
    ["extensions.gen_random_bytes(integer)", "pgcrypto"],
    ["extensions.pgp_sym_encrypt(text, text)", "pgcrypto"],
    ["net.http_post(text, jsonb)", "pg_net"],
  ])("maps a missing %s routine to %s", (routine, extension) => {
    const symbol = routine.slice(0, routine.indexOf("("));
    const findings = legacyClassifyDeclarativeLoadCompatibility({
      implementation: "next",
      manifestPresent: false,
      diagnostics: [
        stuck(
          `schemas/app/tables/members.sql: ERROR: function ${routine} does not exist (failed identically in 6 rounds)`,
        ),
      ],
      files: [
        {
          name: "schemas/app/tables/members.sql",
          sql: `create table app.members (\n  id uuid default ${symbol}()\n);`,
        },
      ],
    });

    expect(findings).toEqual([
      {
        extension,
        signature: `${symbol}()`,
        diagnosticMessage: `schemas/app/tables/members.sql: ERROR: function ${routine} does not exist (failed identically in 6 rounds)`,
        file: "schemas/app/tables/members.sql",
        line: 2,
      },
    ]);
  });

  it.each(["uuid-ossp", "pgcrypto", "pg_net"])(
    "maps a direct missing %s extension diagnostic",
    (extension) => {
      expect(
        legacyClassifyDeclarativeLoadCompatibility({
          implementation: "next",
          manifestPresent: false,
          diagnostics: [
            stuck(`cluster/config.sql: ERROR: extension "${extension}" does not exist`),
          ],
          files: [
            {
              name: "cluster/config.sql",
              sql: `alter extension "${extension}" update;`,
            },
          ],
        }),
      ).toEqual([
        expect.objectContaining({
          extension,
          signature: `extension "${extension}"`,
          file: "cluster/config.sql",
          line: 1,
        }),
      ]);
    },
  );

  it("reports the authored line from the diagnostic's file and ignores cascades", () => {
    const findings = legacyClassifyDeclarativeLoadCompatibility({
      implementation: "next",
      manifestPresent: false,
      diagnostics: [
        stuck(
          "schemas/app/tables/members.sql: ERROR: function extensions.uuid_generate_v4() does not exist",
        ),
        stuck('public.views/members.sql: ERROR: relation "app.members" does not exist'),
      ],
      files: [
        {
          name: "other.sql",
          sql: "select extensions.uuid_generate_v4();",
        },
        {
          name: "schemas/app/tables/members.sql",
          sql: "-- generated table uses extensions.uuid_generate_v4()\r\n\r\ncreate table app.members (\r\n  id uuid default extensions.uuid_generate_v4()\r\n);",
        },
        {
          name: "public.views/members.sql",
          sql: "create view public.members as select * from app.members;",
        },
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      extension: "uuid-ossp",
      file: "schemas/app/tables/members.sql",
      line: 4,
    });
  });

  it("requires next, no manifest, and an error-level non-converging diagnostic", () => {
    const files = [{ name: "members.sql", sql: "select extensions.uuid_generate_v4();" }];
    const diagnostic = stuck("members.sql: function extensions.uuid_generate_v4() does not exist");
    const classify = (
      implementation: "legacy" | "next",
      manifestPresent: boolean,
      diagnostics: ReadonlyArray<{ code: string; severity: string; message: string }>,
    ) =>
      legacyClassifyDeclarativeLoadCompatibility({
        implementation,
        manifestPresent,
        diagnostics,
        files,
      });

    expect(classify("legacy", false, [diagnostic])).toEqual([]);
    expect(classify("next", true, [diagnostic])).toEqual([]);
    expect(classify("next", false, [{ ...diagnostic, severity: "warning" }])).toEqual([]);
    expect(classify("next", false, [{ ...diagnostic, code: "invalid_routine_body" }])).toEqual([]);
    expect(classify("next", false, [{ ...diagnostic, code: "max_rounds_exceeded" }])).toHaveLength(
      1,
    );
  });

  it("does not classify an extension already declared anywhere in the tree", () => {
    expect(
      legacyClassifyDeclarativeLoadCompatibility({
        implementation: "next",
        manifestPresent: false,
        diagnostics: [stuck("members.sql: function extensions.uuid_generate_v4() does not exist")],
        files: [
          { name: "members.sql", sql: "select extensions.uuid_generate_v4();" },
          {
            name: "cluster/extensions/uuid-ossp.sql",
            sql: 'create extension if not exists "uuid-ossp" with schema "extensions";',
          },
        ],
      }),
    ).toEqual([]);
  });

  it("does not treat a commented or quoted declaration as an extension declaration", () => {
    expect(
      legacyClassifyDeclarativeLoadCompatibility({
        implementation: "next",
        manifestPresent: false,
        diagnostics: [stuck("members.sql: function extensions.uuid_generate_v4() does not exist")],
        files: [
          {
            name: "members.sql",
            sql: [
              '-- create extension "uuid-ossp";',
              "select 'create extension uuid-ossp';",
              "select extensions.uuid_generate_v4();",
            ].join("\n"),
          },
        ],
      }),
    ).toEqual([expect.objectContaining({ extension: "uuid-ossp", file: "members.sql", line: 3 })]);
  });

  it("returns an unlocated finding when the diagnostic has no authored match", () => {
    expect(
      legacyClassifyDeclarativeLoadCompatibility({
        implementation: "next",
        manifestPresent: false,
        diagnostics: [stuck('unknown.sql: extension "pg_net" does not exist')],
        files: [],
      }),
    ).toEqual([
      {
        extension: "pg_net",
        signature: 'extension "pg_net"',
        diagnosticMessage: 'unknown.sql: extension "pg_net" does not exist',
      },
    ]);
  });

  it("deduplicates identical findings from repeated load diagnostics", () => {
    const diagnostic = stuck("members.sql: function extensions.uuid_generate_v4() does not exist");
    expect(
      legacyClassifyDeclarativeLoadCompatibility({
        implementation: "next",
        manifestPresent: false,
        diagnostics: [diagnostic, diagnostic],
        files: [{ name: "members.sql", sql: "select extensions.uuid_generate_v4();" }],
      }),
    ).toHaveLength(1);
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
