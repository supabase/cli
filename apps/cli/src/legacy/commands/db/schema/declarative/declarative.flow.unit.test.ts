import { describe, expect, it } from "vitest";

import {
  legacyClassifyDeclarativeCompatibilityGap,
  legacyClassifyDeclarativeLoadCompatibility,
  legacyExtensionDeclaration,
  legacyFormatDeclarativeGapEvidence,
  legacyFormatDeclarativeUpgradeGate,
  legacyFormatStagedExportAdoption,
  legacyResolveDeclarativeMigrationName,
  legacyResolveDeclarativeSyncApplyDecision,
  legacyResolveStagedDeclarativeDir,
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

const classifyGap = (
  overrides: Partial<Parameters<typeof legacyClassifyDeclarativeCompatibilityGap>[0]> = {},
) =>
  legacyClassifyDeclarativeCompatibilityGap({
    implementation: "next",
    manifestPresent: false,
    removals,
    ...overrides,
  });

const classifyLoad = (
  overrides: Partial<Parameters<typeof legacyClassifyDeclarativeLoadCompatibility>[0]>,
) =>
  legacyClassifyDeclarativeLoadCompatibility({
    implementation: "next",
    manifestPresent: false,
    diagnostics: [],
    files: [],
    ...overrides,
  });

describe("legacyClassifyDeclarativeCompatibilityGap", () => {
  it.each([
    {
      name: "repairs known implicit extensions",
      overrides: {
        removals: { extensions: ["uuid-ossp", "pgcrypto", "pgcrypto"], extensionIntents: [] },
      },
      expected: {
        recommendedAction: "repair-extensions",
        repairableExtensions: ["pgcrypto", "uuid-ossp"],
        ambiguousRemovals: [],
      },
    },
    {
      name: "stages mixed known and unknown removals",
      overrides: {
        removals: { extensions: ["pgcrypto", "postgis"], extensionIntents: [] },
      },
      expected: {
        recommendedAction: "stage-next-export",
        repairableExtensions: ["pgcrypto"],
        ambiguousRemovals: ["postgis"],
      },
    },
    {
      name: "stages extension intents",
      overrides: {},
      expected: { recommendedAction: "stage-next-export" },
    },
    {
      name: "trusts a next export manifest",
      overrides: { manifestPresent: true },
      expected: { recommendedAction: "none" },
    },
    {
      name: "leaves legacy behavior unchanged",
      overrides: { implementation: "legacy" as const },
      expected: { recommendedAction: "none" },
    },
    {
      name: "ignores an empty removal set",
      overrides: { removals: { extensions: [], extensionIntents: [] } },
      expected: { recommendedAction: "none" },
    },
  ])("$name", ({ overrides, expected }) => {
    expect(classifyGap(overrides)).toMatchObject(expected);
  });

  it("formats repair and staging instructions", () => {
    expect(legacyExtensionDeclaration("uuid-ossp")).toBe(
      'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";',
    );
    const { suggestion } = legacyFormatDeclarativeUpgradeGate({
      evidence: legacyFormatDeclarativeGapEvidence(classifyGap()),
      context: { declarativeDir: "supabase/schemas", schema: [], platform: "posix" },
    });
    expect(suggestion).toContain(
      "generate --local --overwrite \\\n    --output-dir supabase/schemas-next --experimental",
    );
  });

  it("derives staged-export commands from a custom declarative path", () => {
    const { suggestion } = legacyFormatDeclarativeUpgradeGate({
      evidence: legacyFormatDeclarativeGapEvidence(classifyGap()),
      context: { declarativeDir: "supabase/custom schema", schema: [], platform: "posix" },
    });

    expect(suggestion).toContain("--output-dir 'supabase/custom schema-next'");
    expect(suggestion).toContain(
      "rm -rf 'supabase/custom schema' && mv 'supabase/custom schema-next' 'supabase/custom schema'",
    );
  });

  it("preserves schema filters in staged-export and follow-up sync commands", () => {
    const { suggestion } = legacyFormatDeclarativeUpgradeGate({
      evidence: legacyFormatDeclarativeGapEvidence(classifyGap()),
      context: {
        declarativeDir: "supabase/schemas",
        schema: ["app", "tenant,one"],
        platform: "posix",
      },
    });

    expect(suggestion).toContain(
      `--output-dir supabase/schemas-next --schema app --schema '"tenant,one"' --experimental`,
    );
    expect(suggestion).toContain(
      `sync --no-apply --schema app --schema '"tenant,one"' --experimental`,
    );
  });
});

describe("legacyFormatDeclarativeUpgradeGate", () => {
  it("renders one template with indented evidence and no --debug-style guidance", () => {
    const gate = legacyFormatDeclarativeUpgradeGate({
      evidence: legacyFormatDeclarativeGapEvidence(classifyGap()),
      context: { declarativeDir: "supabase/schemas", schema: [], platform: "posix" },
    });

    expect(gate.message).toBe(
      [
        "This supabase/schemas tree looks like a legacy pg-delta export.",
        "pg-delta next only loads extensions the tree declares; legacy exports omitted",
        "platform extensions and extension-managed objects like cron jobs.",
        "",
        "  Legacy-implicit extensions: pgcrypto, uuid-ossp",
        "  Extension-managed objects: pg_cron job refresh download metrics, pgmq queue emails",
        "",
        "Do not apply a sync generated from this tree — it can drop extensions or unschedule jobs.",
      ].join("\n"),
    );
    expect(gate.suggestion).toBe(
      [
        "Upgrade without changing the active supabase/schemas tree:",
        "",
        "  supabase db schema declarative generate --local --overwrite \\",
        "    --output-dir supabase/schemas-next --experimental",
        "  # review supabase/schemas-next",
        "  rm -rf supabase/schemas && mv supabase/schemas-next supabase/schemas",
        "  supabase db schema declarative sync --no-apply --experimental",
      ].join("\n"),
    );
  });

  it("offers no extension.sql alternative — the staged upgrade is the only recovery", () => {
    const gate = legacyFormatDeclarativeUpgradeGate({
      evidence: [
        "members.sql:3 uses extensions.uuid_generate_v4(), but the tree does not declare uuid-ossp.",
      ],
      context: { declarativeDir: "supabase/schemas", schema: [], platform: "posix" },
    });

    expect(`${gate.message}\n${gate.suggestion}`).not.toContain("extension.sql");
    expect(gate.message).toContain(
      "  members.sql:3 uses extensions.uuid_generate_v4(), but the tree does not declare uuid-ossp.",
    );
  });

  it("reports ambiguous extension removals as their own evidence line", () => {
    expect(
      legacyFormatDeclarativeGapEvidence(
        classifyGap({ removals: { extensions: ["postgis"], extensionIntents: [] } }),
      ),
    ).toEqual(["Extensions: postgis"]);
  });

  it("omits the evidence block entirely when there is nothing to report", () => {
    const gate = legacyFormatDeclarativeUpgradeGate({
      evidence: [],
      context: { declarativeDir: "supabase/schemas", schema: [], platform: "posix" },
    });

    expect(gate.message).not.toContain("\n\n\n");
  });

  it("renders single-line PowerShell recovery commands on windows", () => {
    const gate = legacyFormatDeclarativeUpgradeGate({
      evidence: [],
      context: { declarativeDir: "supabase/custom schema", schema: [], platform: "windows" },
    });

    expect(gate.suggestion).toContain(
      "  supabase db schema declarative generate --local --overwrite --output-dir 'supabase/custom schema-next' --experimental",
    );
    expect(gate.suggestion).toContain(
      "  Remove-Item -Recurse -Force -ErrorAction Stop 'supabase/custom schema'; Move-Item 'supabase/custom schema-next' 'supabase/custom schema'",
    );
    // No POSIX-isms anywhere in the windows recipe: it must run as printed.
    expect(gate.suggestion).not.toContain("rm -rf");
    expect(gate.suggestion).not.toContain(" && ");
    expect(gate.suggestion).not.toContain("\\\n");
  });

  it("escapes quotes PowerShell-style in windows adoption commands", () => {
    const lines = legacyFormatStagedExportAdoption({
      declarativeDir: "supabase/it's here",
      schema: [],
      platform: "windows",
    });
    expect(lines.join("\n")).toContain(
      "Remove-Item -Recurse -Force -ErrorAction Stop 'supabase/it''s here'; Move-Item 'supabase/it''s here-next' 'supabase/it''s here'",
    );
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
    const findings = classifyLoad({
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
        classifyLoad({
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
    const findings = classifyLoad({
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
      classifyLoad({
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
      classifyLoad({
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
      classifyLoad({
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
      classifyLoad({
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
      classifyLoad({
        diagnostics: [diagnostic, diagnostic],
        files: [{ name: "members.sql", sql: "select extensions.uuid_generate_v4();" }],
      }),
    ).toHaveLength(1);
  });
});

describe("legacyResolveStagedDeclarativeDir", () => {
  it("suffixes the last path segment to produce a sibling directory", () => {
    expect(legacyResolveStagedDeclarativeDir("supabase/schemas")).toBe("supabase/schemas-next");
  });

  it("strips trailing separators so the staged dir cannot nest inside the tree", () => {
    expect(legacyResolveStagedDeclarativeDir("./schemas/")).toBe("./schemas-next");
    expect(legacyResolveStagedDeclarativeDir("supabase/schemas//")).toBe("supabase/schemas-next");
    expect(legacyResolveStagedDeclarativeDir("supabase\\schemas\\")).toBe("supabase\\schemas-next");
  });

  it("strips trailing current-directory segments", () => {
    expect(legacyResolveStagedDeclarativeDir("supabase/schemas/.")).toBe("supabase/schemas-next");
    expect(legacyResolveStagedDeclarativeDir("supabase/schemas/./")).toBe("supabase/schemas-next");
  });

  it("prints adoption commands that target the sibling staged directory", () => {
    const lines = legacyFormatStagedExportAdoption({
      declarativeDir: "./schemas/",
      schema: [],
      platform: "posix",
    });
    expect(lines.join("\n")).toContain("rm -rf ./schemas/ && mv ./schemas-next ./schemas/");
  });
});

describe("legacyResolveDeclarativeMigrationName", () => {
  it.each([
    ["my_change", "declarative_sync", "my_change"],
    ["", "declarative_sync", "declarative_sync"],
  ])("resolves name=%j file=%j", (name, file, expected) => {
    expect(legacyResolveDeclarativeMigrationName(name, file)).toBe(expected);
  });
});

describe("legacyResolveDeclarativeSyncApplyDecision", () => {
  it.each([
    ["--no-apply wins", { apply: true, noApply: true, yes: true, tty: true }, "skip"],
    ["--apply applies", { apply: true, noApply: false, yes: false, tty: false }, "apply"],
    ["--yes applies", { apply: false, noApply: false, yes: true, tty: false }, "apply"],
    ["TTY prompts", { apply: false, noApply: false, yes: false, tty: true }, "prompt"],
    [
      "non-interactive defaults to skip",
      { apply: false, noApply: false, yes: false, tty: false },
      "skip",
    ],
  ] as const)("%s", (_name, options, expected) => {
    expect(legacyResolveDeclarativeSyncApplyDecision(options)).toBe(expected);
  });
});
