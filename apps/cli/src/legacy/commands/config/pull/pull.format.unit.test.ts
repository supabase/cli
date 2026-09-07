import type { ConfigChange, ConfigChangeSet } from "@supabase/config";
import { describe, expect, test } from "vitest";

import {
  LEGACY_CONFIG_PULL_PAYLOAD_VERSION,
  legacyConfigPullDestinationLine,
  legacyConfigPullPayload,
  legacyConfigPullSummaryMessage,
  type LegacyConfigPullContext,
  type LegacyConfigPullOutcome,
  legacyRenderConfigPullText,
} from "./pull.format.ts";
import type { LegacyConfigPullPlan } from "./pull.plan.ts";
import type { LegacyConfigPullDestination } from "./pull.scope.ts";

const PROJECT_REF = "abcdefghijklmnopqrst";
const BRANCH_UUID = "11111111-1111-1111-1111-111111111111";

function emptyChangeSet(): ConfigChangeSet {
  return {
    changes: [],
    masked: [],
    unmanaged: [],
    absencePolicy: "absent-is-hands-off",
    counts: { update: 0, remote_only: 0, local_only: 0, total: 0 },
  };
}

function emptyPlan(): LegacyConfigPullPlan {
  return { writes: [], skipped: [], warnings: [], createdTable: undefined };
}

const NOT_DECLINED: LegacyConfigPullOutcome = { dryRun: false, declined: false };

describe("legacyConfigPullDestinationLine", () => {
  test("a bare project ref target writing to the config root", () => {
    expect(
      legacyConfigPullDestinationLine(
        { projectRef: PROJECT_REF, branch: undefined },
        { kind: "root" },
      ),
    ).toBe(`Pulling config from project ${PROJECT_REF} → config root\n`);
  });

  test("a named branch target writing to a remote block", () => {
    expect(
      legacyConfigPullDestinationLine(
        { projectRef: PROJECT_REF, branch: "staging" },
        { kind: "remote", label: "staging", created: true },
      ),
    ).toBe(`Pulling config from 'staging' (branch ${PROJECT_REF}) → [remotes.staging]\n`);
  });

  test("a UUID branch target writing to a remote block", () => {
    expect(
      legacyConfigPullDestinationLine(
        { projectRef: PROJECT_REF, branch: BRANCH_UUID },
        { kind: "remote", label: PROJECT_REF, created: true },
      ),
    ).toBe(
      `Pulling config from branch ${BRANCH_UUID} (project ref ${PROJECT_REF}) → [remotes.${PROJECT_REF}]\n`,
    );
  });

  test("a hostile branch/label name cannot forge additional output lines", () => {
    const line = legacyConfigPullDestinationLine(
      { projectRef: PROJECT_REF, branch: "staging\nNo config differences found." },
      { kind: "remote", label: "staging\nFAKE", created: true },
    );
    expect(line).toBe(
      `Pulling config from 'staging No config differences found.' (branch ${PROJECT_REF}) → [remotes.staging FAKE]\n`,
    );
    expect(line.split("\n")).toHaveLength(2);
  });
});

describe("legacyConfigPullSummaryMessage", () => {
  test("no differences at all", () => {
    expect(
      legacyConfigPullSummaryMessage(
        emptyChangeSet(),
        { present: [], missing: [] },
        emptyPlan(),
        NOT_DECLINED,
      ),
    ).toBe("No config differences found.");
  });

  test("differences existed but nothing was written — distinct from no differences", () => {
    const change: ConfigChange = {
      path: ["api", "max_rows"],
      class: "update",
      local: 500,
      remote: 1000,
      declared: true,
    };
    const cs: ConfigChangeSet = {
      changes: [change],
      masked: [],
      unmanaged: [],
      absencePolicy: "absent-is-hands-off",
      counts: { update: 1, remote_only: 0, local_only: 0, total: 1 },
    };
    const plan: LegacyConfigPullPlan = {
      writes: [],
      skipped: [{ change, reason: "env_reference" }],
      warnings: [],
      createdTable: undefined,
    };
    expect(
      legacyConfigPullSummaryMessage(cs, { present: [], missing: [] }, plan, NOT_DECLINED),
    ).toBe("No changes written.");
  });

  test("wrote N distinguishes from would-write-N (dry run) and declined", () => {
    const change: ConfigChange = {
      path: ["api", "max_rows"],
      class: "update",
      local: 500,
      remote: 1000,
      declared: true,
    };
    const cs: ConfigChangeSet = {
      changes: [change],
      masked: [],
      unmanaged: [],
      absencePolicy: "absent-is-hands-off",
      counts: { update: 1, remote_only: 0, local_only: 0, total: 1 },
    };
    const plan: LegacyConfigPullPlan = {
      writes: [{ change, documentPath: change.path, value: 1000 }],
      skipped: [],
      warnings: [],
      createdTable: undefined,
    };
    const scope = { present: [], missing: [] };

    expect(
      legacyConfigPullSummaryMessage(cs, scope, plan, { dryRun: false, declined: false }),
    ).toBe("1 change written.");
    expect(legacyConfigPullSummaryMessage(cs, scope, plan, { dryRun: true, declined: false })).toBe(
      "1 change would be written (dry run).",
    );
    expect(legacyConfigPullSummaryMessage(cs, scope, plan, { dryRun: false, declined: true })).toBe(
      "1 change not written (declined).",
    );
  });

  test("a block-only plan (no value writes) gets its own wording, distinct from no-differences and from a value write", () => {
    const blockOnlyPlan: LegacyConfigPullPlan = {
      writes: [],
      skipped: [],
      warnings: [],
      createdTable: ["remotes", "staging"],
    };
    const scope = { present: [], missing: [] };
    expect(
      legacyConfigPullSummaryMessage(emptyChangeSet(), scope, blockOnlyPlan, NOT_DECLINED),
    ).toBe("Created [remotes.staging]; no config differences to apply.");
    expect(
      legacyConfigPullSummaryMessage(emptyChangeSet(), scope, blockOnlyPlan, {
        dryRun: true,
        declined: false,
      }),
    ).toBe("[remotes.staging] would be created (dry run); no config differences to apply.");
    expect(
      legacyConfigPullSummaryMessage(emptyChangeSet(), scope, blockOnlyPlan, {
        dryRun: false,
        declined: true,
      }),
    ).toBe("[remotes.staging] not created (declined).");
  });

  test("a block-only plan whose differences were ALL skipped is distinguished from 'no differences' (CLI-2064 review, T2)", () => {
    const change: ConfigChange = {
      path: ["auth", "site_url"],
      class: "update",
      local: "env(SITE_URL)",
      remote: "https://staging.example.com",
      declared: true,
      envVariables: ["SITE_URL"],
    };
    const cs: ConfigChangeSet = {
      changes: [change],
      masked: [],
      unmanaged: [],
      absencePolicy: "absent-is-hands-off",
      counts: { update: 1, remote_only: 0, local_only: 0, total: 1 },
    };
    const blockOnlyPlan: LegacyConfigPullPlan = {
      writes: [],
      skipped: [{ change, reason: "env_reference" }],
      warnings: [],
      createdTable: ["remotes", "staging"],
    };
    const scope = { present: [], missing: [] };
    expect(legacyConfigPullSummaryMessage(cs, scope, blockOnlyPlan, NOT_DECLINED)).toBe(
      "Created [remotes.staging]; 1 difference found but not written (skipped).",
    );
    expect(
      legacyConfigPullSummaryMessage(cs, scope, blockOnlyPlan, { dryRun: true, declined: false }),
    ).toBe(
      "[remotes.staging] would be created (dry run); 1 difference found but not written (skipped).",
    );
  });

  test("a block-only plan's ALL-skipped wording pluralizes with more than one difference", () => {
    const changeA: ConfigChange = {
      path: ["auth", "site_url"],
      class: "local_only",
      local: "https://local.example.com",
      remote: undefined,
      declared: true,
    };
    const changeB: ConfigChange = {
      path: ["api", "max_rows"],
      class: "local_only",
      local: 500,
      remote: undefined,
      declared: true,
    };
    const cs: ConfigChangeSet = {
      changes: [changeA, changeB],
      masked: [],
      unmanaged: [],
      absencePolicy: "absent-is-hands-off",
      counts: { update: 0, remote_only: 0, local_only: 2, total: 2 },
    };
    const blockOnlyPlan: LegacyConfigPullPlan = {
      writes: [],
      skipped: [
        { change: changeA, reason: "local_only" },
        { change: changeB, reason: "local_only" },
      ],
      warnings: [],
      createdTable: ["remotes", "staging"],
    };
    expect(
      legacyConfigPullSummaryMessage(cs, { present: [], missing: [] }, blockOnlyPlan, NOT_DECLINED),
    ).toBe("Created [remotes.staging]; 2 differences found but not written (skipped).");
  });

  test("a hostile block label cannot forge additional output in the summary message", () => {
    const blockOnlyPlan: LegacyConfigPullPlan = {
      writes: [],
      skipped: [],
      warnings: [],
      createdTable: ["remotes", "staging\nFAKE"],
    };
    const message = legacyConfigPullSummaryMessage(
      emptyChangeSet(),
      { present: [], missing: [] },
      blockOnlyPlan,
      NOT_DECLINED,
    );
    expect(message).toBe("Created [remotes.staging FAKE]; no config differences to apply.");
  });

  test("caveats travel with the summary message", () => {
    const cs: ConfigChangeSet = {
      ...emptyChangeSet(),
      masked: [["auth", "external", "github", "secret"]],
    };
    expect(
      legacyConfigPullSummaryMessage(
        cs,
        { present: ["api"], missing: ["storage"] },
        emptyPlan(),
        NOT_DECLINED,
      ),
    ).toBe(
      "No config differences found. 1 block was not returned by the API and was not compared: storage. " +
        "1 credential value not compared (masked by the API): auth.external.github.secret.",
    );
  });

  test("withCaveats: false drops the caveats — for the TEXT one-line disposition, which already showed them in the body", () => {
    const cs: ConfigChangeSet = {
      ...emptyChangeSet(),
      masked: [["auth", "external", "github", "secret"]],
    };
    expect(
      legacyConfigPullSummaryMessage(
        cs,
        { present: ["api"], missing: ["storage"] },
        emptyPlan(),
        NOT_DECLINED,
        { withCaveats: false },
      ),
    ).toBe("No config differences found.");
  });
});

describe("legacyConfigPullPayload", () => {
  test("full payload shape", () => {
    const change: ConfigChange = {
      path: ["api", "max_rows"],
      class: "update",
      local: 500,
      remote: 1000,
      declared: true,
    };
    const changeSet: ConfigChangeSet = {
      changes: [change],
      masked: [],
      unmanaged: [],
      absencePolicy: "absent-is-hands-off",
      counts: { update: 1, remote_only: 0, local_only: 0, total: 1 },
    };
    const plan: LegacyConfigPullPlan = {
      writes: [{ change, documentPath: ["remotes", "staging", "api", "max_rows"], value: 1000 }],
      skipped: [],
      warnings: [],
      createdTable: ["remotes", "staging"],
    };
    const destination: LegacyConfigPullDestination = {
      kind: "remote",
      label: "staging",
      created: true,
    };
    const context: LegacyConfigPullContext = {
      projectRef: PROJECT_REF,
      branch: "staging",
      configSchema: "https://example.com/schema.json",
      configPath: "supabase/config.toml",
      format: "toml",
      appliedRemote: undefined,
      destination,
    };

    expect(
      legacyConfigPullPayload(
        changeSet,
        { present: ["api"], missing: [] },
        plan,
        context,
        NOT_DECLINED,
      ),
    ).toEqual({
      schema_version: LEGACY_CONFIG_PULL_PAYLOAD_VERSION,
      config_schema: "https://example.com/schema.json",
      config_path: "supabase/config.toml",
      format: "toml",
      target: { project_ref: PROJECT_REF, branch: "staging", local_scope: "base" },
      destination: { scope: "remotes.staging", label: "staging", created: true },
      dry_run: false,
      wrote: true,
      scope: { present: ["api"], missing: [] },
      changes: [
        {
          path: ["api", "max_rows"],
          class: "update",
          declared: true,
          local: 500,
          remote: 1000,
          written: true,
          document_path: ["remotes", "staging", "api", "max_rows"],
        },
      ],
      warnings: [],
      masked: [],
      unmanaged: [],
      counts: { update: 1, remote_only: 0, local_only: 0, total: 1, written: 1, skipped: 0 },
    });
  });

  test("a skipped change carries its reason and written:false", () => {
    const change: ConfigChange = {
      path: ["db", "port"],
      class: "update",
      local: 5432,
      remote: 5433,
      declared: true,
      envVariables: ["DB_PORT"],
    };
    const changeSet: ConfigChangeSet = {
      changes: [change],
      masked: [],
      unmanaged: [],
      absencePolicy: "absent-is-hands-off",
      counts: { update: 1, remote_only: 0, local_only: 0, total: 1 },
    };
    const plan: LegacyConfigPullPlan = {
      writes: [],
      skipped: [{ change, reason: "env_reference" }],
      warnings: [],
      createdTable: undefined,
    };
    const context: LegacyConfigPullContext = {
      projectRef: PROJECT_REF,
      branch: undefined,
      configSchema: "https://example.com/schema.json",
      configPath: "supabase/config.toml",
      format: "toml",
      appliedRemote: undefined,
      destination: { kind: "root" },
    };

    const payload = legacyConfigPullPayload(
      changeSet,
      { present: [], missing: [] },
      plan,
      context,
      NOT_DECLINED,
    );
    expect(payload["changes"]).toEqual([
      {
        path: ["db", "port"],
        class: "update",
        declared: true,
        local: 5432,
        remote: 5433,
        env_variables: ["DB_PORT"],
        written: false,
        skipped_reason: "env_reference",
      },
    ]);
    expect(payload["wrote"]).toBe(false);
    expect(payload["counts"]).toEqual({
      update: 1,
      remote_only: 0,
      local_only: 0,
      total: 1,
      written: 0,
      skipped: 1,
    });
  });

  test("a remote-env-reference-skipped change carries skipped_reason remote_env_reference in the payload", () => {
    const change: ConfigChange = {
      path: ["auth", "site_url"],
      class: "update",
      local: "https://local.example.com",
      remote: "env(SUPABASE_ACCESS_TOKEN)",
      declared: true,
    };
    const changeSet: ConfigChangeSet = {
      changes: [change],
      masked: [],
      unmanaged: [],
      absencePolicy: "absent-is-hands-off",
      counts: { update: 1, remote_only: 0, local_only: 0, total: 1 },
    };
    const plan: LegacyConfigPullPlan = {
      writes: [],
      skipped: [{ change, reason: "remote_env_reference" }],
      warnings: [],
      createdTable: undefined,
    };
    const context: LegacyConfigPullContext = {
      projectRef: PROJECT_REF,
      branch: undefined,
      configSchema: "https://example.com/schema.json",
      configPath: "supabase/config.toml",
      format: "toml",
      appliedRemote: undefined,
      destination: { kind: "root" },
    };

    const payload = legacyConfigPullPayload(
      changeSet,
      { present: [], missing: [] },
      plan,
      context,
      NOT_DECLINED,
    );
    expect(payload["changes"]).toEqual([
      {
        path: ["auth", "site_url"],
        class: "update",
        declared: true,
        local: "https://local.example.com",
        remote: "env(SUPABASE_ACCESS_TOKEN)",
        written: false,
        skipped_reason: "remote_env_reference",
      },
    ]);
    expect(payload["wrote"]).toBe(false);
    expect(payload["counts"]).toEqual({
      update: 1,
      remote_only: 0,
      local_only: 0,
      total: 1,
      written: 0,
      skipped: 1,
    });
  });

  test("a dry-run outcome reports every planned write as skipped_reason dry_run", () => {
    const change: ConfigChange = {
      path: ["api", "max_rows"],
      class: "update",
      local: 500,
      remote: 1000,
      declared: true,
    };
    const changeSet: ConfigChangeSet = {
      changes: [change],
      masked: [],
      unmanaged: [],
      absencePolicy: "absent-is-hands-off",
      counts: { update: 1, remote_only: 0, local_only: 0, total: 1 },
    };
    const plan: LegacyConfigPullPlan = {
      writes: [{ change, documentPath: change.path, value: 1000 }],
      skipped: [],
      warnings: [],
      createdTable: undefined,
    };
    const context: LegacyConfigPullContext = {
      projectRef: PROJECT_REF,
      branch: undefined,
      configSchema: "https://example.com/schema.json",
      configPath: "supabase/config.toml",
      format: "toml",
      appliedRemote: undefined,
      destination: { kind: "root" },
    };

    const payload = legacyConfigPullPayload(
      changeSet,
      { present: [], missing: [] },
      plan,
      context,
      {
        dryRun: true,
        declined: false,
      },
    );
    expect(payload["dry_run"]).toBe(true);
    expect(payload["wrote"]).toBe(false);
    expect((payload["changes"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      written: false,
      skipped_reason: "dry_run",
    });
    // A dry-run change was only ever PLANNED to write, never actually
    // written — `document_path` is reserved for entries the payload also
    // marks `written: true`.
    expect((payload["changes"] as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
      "document_path",
    );
  });

  test("a declined outcome reports every planned write as skipped_reason declined", () => {
    const change: ConfigChange = {
      path: ["api", "max_rows"],
      class: "update",
      local: 500,
      remote: 1000,
      declared: true,
    };
    const changeSet: ConfigChangeSet = {
      changes: [change],
      masked: [],
      unmanaged: [],
      absencePolicy: "absent-is-hands-off",
      counts: { update: 1, remote_only: 0, local_only: 0, total: 1 },
    };
    const plan: LegacyConfigPullPlan = {
      writes: [{ change, documentPath: change.path, value: 1000 }],
      skipped: [],
      warnings: [],
      createdTable: undefined,
    };
    const context: LegacyConfigPullContext = {
      projectRef: PROJECT_REF,
      branch: undefined,
      configSchema: "https://example.com/schema.json",
      configPath: "supabase/config.toml",
      format: "toml",
      appliedRemote: undefined,
      destination: { kind: "root" },
    };

    const payload = legacyConfigPullPayload(
      changeSet,
      { present: [], missing: [] },
      plan,
      context,
      {
        dryRun: false,
        declined: true,
      },
    );
    expect(payload["wrote"]).toBe(false);
    expect((payload["changes"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      written: false,
      skipped_reason: "declined",
    });
  });

  test("a block-only plan reports wrote:true and counts.written:0 once actually created, but wrote:false for dry-run/declined", () => {
    const plan: LegacyConfigPullPlan = {
      writes: [],
      skipped: [],
      warnings: [],
      createdTable: ["remotes", "staging"],
    };
    const destination: LegacyConfigPullDestination = {
      kind: "remote",
      label: "staging",
      created: true,
    };
    const context: LegacyConfigPullContext = {
      projectRef: PROJECT_REF,
      branch: "staging",
      configSchema: "https://example.com/schema.json",
      configPath: "supabase/config.toml",
      format: "toml",
      appliedRemote: undefined,
      destination,
    };

    const created = legacyConfigPullPayload(
      emptyChangeSet(),
      { present: [], missing: [] },
      plan,
      context,
      NOT_DECLINED,
    );
    expect(created["wrote"]).toBe(true);
    expect(created["destination"]).toEqual({
      scope: "remotes.staging",
      label: "staging",
      created: true,
    });
    expect((created["counts"] as Record<string, unknown>)["written"]).toBe(0);

    const dryRun = legacyConfigPullPayload(
      emptyChangeSet(),
      { present: [], missing: [] },
      plan,
      context,
      { dryRun: true, declined: false },
    );
    expect(dryRun["wrote"]).toBe(false);

    const declined = legacyConfigPullPayload(
      emptyChangeSet(),
      { present: [], missing: [] },
      plan,
      context,
      { dryRun: false, declined: true },
    );
    expect(declined["wrote"]).toBe(false);
  });

  test("warnings carry their path", () => {
    const context: LegacyConfigPullContext = {
      projectRef: PROJECT_REF,
      branch: undefined,
      configSchema: "https://example.com/schema.json",
      configPath: "supabase/config.toml",
      format: "toml",
      appliedRemote: "staging",
      destination: { kind: "remote", label: "staging", created: false },
    };
    const plan: LegacyConfigPullPlan = {
      writes: [],
      skipped: [],
      warnings: [{ kind: "dual_scope", path: ["auth", "site_url"] }],
      createdTable: undefined,
    };
    const payload = legacyConfigPullPayload(
      emptyChangeSet(),
      { present: [], missing: [] },
      plan,
      context,
      NOT_DECLINED,
    );
    expect(payload["warnings"]).toEqual([{ kind: "dual_scope", path: ["auth", "site_url"] }]);
    expect(payload["target"]).toEqual({ project_ref: PROJECT_REF, local_scope: "remotes.staging" });
  });
});

describe("legacyRenderConfigPullText", () => {
  test("renders local/remote lines, write/skip markers, and a summary", () => {
    const written: ConfigChange = {
      path: ["api", "max_rows"],
      class: "update",
      local: 500,
      remote: 1000,
      declared: true,
    };
    const skipped: ConfigChange = {
      path: ["auth", "enable_signup"],
      class: "local_only",
      local: true,
      remote: undefined,
      declared: true,
    };
    const changeSet: ConfigChangeSet = {
      changes: [written, skipped],
      masked: [],
      unmanaged: [],
      absencePolicy: "absent-is-hands-off",
      counts: { update: 1, remote_only: 0, local_only: 1, total: 2 },
    };
    const plan: LegacyConfigPullPlan = {
      writes: [{ change: written, documentPath: written.path, value: 1000 }],
      skipped: [{ change: skipped, reason: "local_only" }],
      warnings: [],
      createdTable: undefined,
    };

    const text = legacyRenderConfigPullText(
      changeSet,
      { present: ["api", "auth"], missing: [] },
      plan,
      PROJECT_REF,
      "supabase/config.toml",
    );
    expect(text).toContain("api.max_rows [update, write]");
    expect(text).toContain("  local:  500");
    expect(text).toContain("  remote: 1000");
    expect(text).toContain("auth.enable_signup [local-only, not pulled]");
    expect(text).toContain("2 differences found (1 to write, 1 to skip).");
  });

  test("a hostile path segment cannot forge additional output lines", () => {
    const change: ConfigChange = {
      path: ["auth", "sms", "test_otp", "hostile\nNo config differences found."],
      class: "remote_only",
      local: undefined,
      remote: "000000",
      declared: false,
    };
    const changeSet: ConfigChangeSet = {
      changes: [change],
      masked: [],
      unmanaged: [],
      absencePolicy: "absent-is-hands-off",
      counts: { update: 0, remote_only: 1, local_only: 0, total: 1 },
    };
    const plan: LegacyConfigPullPlan = {
      writes: [{ change, documentPath: change.path, value: "000000" }],
      skipped: [],
      warnings: [],
      createdTable: undefined,
    };
    const text = legacyRenderConfigPullText(
      changeSet,
      { present: [], missing: [] },
      plan,
      PROJECT_REF,
      "supabase/config.toml",
    );
    expect(text).toContain(
      "auth.sms.test_otp.hostile No config differences found. [remote-only, write]",
    );
  });

  test("a plan that also creates a block notes it", () => {
    const change: ConfigChange = {
      path: ["api", "max_rows"],
      class: "update",
      local: 500,
      remote: 1000,
      declared: true,
    };
    const changeSet: ConfigChangeSet = {
      changes: [change],
      masked: [],
      unmanaged: [],
      absencePolicy: "absent-is-hands-off",
      counts: { update: 1, remote_only: 0, local_only: 0, total: 1 },
    };
    const plan: LegacyConfigPullPlan = {
      writes: [{ change, documentPath: ["remotes", "staging", ...change.path], value: 1000 }],
      skipped: [],
      warnings: [],
      createdTable: ["remotes", "staging"],
    };
    const text = legacyRenderConfigPullText(
      changeSet,
      { present: [], missing: [] },
      plan,
      PROJECT_REF,
      "supabase/config.toml",
    );
    expect(text).toContain(
      `New block [remotes.staging] will be created (project_id = ${PROJECT_REF}).`,
    );
  });

  test("a block-only plan (no value writes) ALSO carries the new-block note in the body, not just its own confirmation prompt", () => {
    const plan: LegacyConfigPullPlan = {
      writes: [],
      skipped: [],
      warnings: [],
      createdTable: ["remotes", "staging"],
    };
    const text = legacyRenderConfigPullText(
      emptyChangeSet(),
      { present: [], missing: [] },
      plan,
      PROJECT_REF,
      "supabase/config.toml",
    );
    expect(text).toContain(
      `New block [remotes.staging] will be created (project_id = ${PROJECT_REF}).`,
    );
  });

  test("a hostile block label cannot forge additional output lines", () => {
    const change: ConfigChange = {
      path: ["api", "max_rows"],
      class: "update",
      local: 500,
      remote: 1000,
      declared: true,
    };
    const changeSet: ConfigChangeSet = {
      changes: [change],
      masked: [],
      unmanaged: [],
      absencePolicy: "absent-is-hands-off",
      counts: { update: 1, remote_only: 0, local_only: 0, total: 1 },
    };
    const plan: LegacyConfigPullPlan = {
      writes: [{ change, documentPath: ["remotes", "staging", ...change.path], value: 1000 }],
      skipped: [],
      warnings: [],
      createdTable: ["remotes", "staging\nNo config differences found."],
    };
    const text = legacyRenderConfigPullText(
      changeSet,
      { present: [], missing: [] },
      plan,
      PROJECT_REF,
      "supabase/config.toml",
    );
    expect(text).toContain(
      "New block [remotes.staging No config differences found.] will be created",
    );
    expect(text.split("New block").length).toBe(2);
  });

  test("the uncommitted-changes warning names the REAL config path and offers the same remediation as the abort error", () => {
    const plan: LegacyConfigPullPlan = {
      writes: [],
      skipped: [],
      warnings: [{ kind: "uncommitted_changes" }],
      createdTable: undefined,
    };
    const text = legacyRenderConfigPullText(
      emptyChangeSet(),
      { present: [], missing: [] },
      plan,
      PROJECT_REF,
      "supabase/config.json",
    );
    expect(text).toContain(
      "supabase/config.json has uncommitted or untracked changes. Commit or stash them (-u for untracked), or rerun with --force.",
    );
  });

  test("a would_invalidate-skipped change renders the humanized reason inline", () => {
    const change: ConfigChange = {
      path: ["auth", "sms", "twilio", "enabled"],
      class: "update",
      local: false,
      remote: true,
      declared: true,
    };
    const changeSet: ConfigChangeSet = {
      changes: [change],
      masked: [],
      unmanaged: [],
      absencePolicy: "absent-is-hands-off",
      counts: { update: 1, remote_only: 0, local_only: 0, total: 1 },
    };
    const plan: LegacyConfigPullPlan = {
      writes: [],
      skipped: [{ change, reason: "would_invalidate" }],
      warnings: [],
      createdTable: undefined,
    };
    const text = legacyRenderConfigPullText(
      changeSet,
      { present: [], missing: [] },
      plan,
      PROJECT_REF,
      "supabase/config.toml",
    );
    expect(text).toContain(
      "auth.sms.twilio.enabled [update, skip: requires values pull cannot write]",
    );
  });

  test("a remote_env_reference-skipped change renders its own humanized reason, distinct from the local env_reference wording", () => {
    const change: ConfigChange = {
      path: ["auth", "site_url"],
      class: "update",
      local: "https://local.example.com",
      remote: "env(SUPABASE_ACCESS_TOKEN)",
      declared: true,
    };
    const changeSet: ConfigChangeSet = {
      changes: [change],
      masked: [],
      unmanaged: [],
      absencePolicy: "absent-is-hands-off",
      counts: { update: 1, remote_only: 0, local_only: 0, total: 1 },
    };
    const plan: LegacyConfigPullPlan = {
      writes: [],
      skipped: [{ change, reason: "remote_env_reference" }],
      warnings: [],
      createdTable: undefined,
    };
    const text = legacyRenderConfigPullText(
      changeSet,
      { present: [], missing: [] },
      plan,
      PROJECT_REF,
      "supabase/config.toml",
    );
    expect(text).toContain(
      "auth.site_url [update, skip: remote value looks like env() — not written]",
    );
  });

  test("a would_invalidate warning names the missing field(s), with no env var mention when none applies", () => {
    const plan: LegacyConfigPullPlan = {
      ...emptyPlan(),
      warnings: [
        {
          kind: "would_invalidate",
          path: ["auth", "sms", "twilio"],
          missingFields: [{ path: ["auth", "sms", "twilio", "message_service_sid"] }],
        },
      ],
    };
    const text = legacyRenderConfigPullText(
      emptyChangeSet(),
      { present: [], missing: [] },
      plan,
      PROJECT_REF,
      "supabase/config.toml",
    );
    expect(text).toContain(
      "auth.sms.twilio was not changed: it requires auth.sms.twilio.message_service_sid — configure it manually.",
    );
  });

  test("a would_invalidate warning names the exact env var to set when a missing field is env()-sourced", () => {
    const plan: LegacyConfigPullPlan = {
      ...emptyPlan(),
      warnings: [
        {
          kind: "would_invalidate",
          path: ["auth", "sms", "twilio"],
          missingFields: [
            {
              path: ["auth", "sms", "twilio", "auth_token"],
              envVariable: "SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN",
            },
          ],
        },
      ],
    };
    const text = legacyRenderConfigPullText(
      emptyChangeSet(),
      { present: [], missing: [] },
      plan,
      PROJECT_REF,
      "supabase/config.toml",
    );
    expect(text).toContain(
      "auth.sms.twilio was not changed: it requires auth.sms.twilio.auth_token — set SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN and rerun, or configure it manually.",
    );
  });
});
