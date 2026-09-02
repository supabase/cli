import type { ConfigChange, ConfigChangeSet } from "@supabase/config/internal";
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
    );
    expect(text).toContain("api.max_rows [update, write]");
    expect(text).toContain("  local:  500");
    expect(text).toContain("  remote: 1000");
    expect(text).toContain("auth.enable_signup [local_only, skip: local_only]");
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
      counts: { update: 0, remote_only: 1, local_only: 0, total: 1 },
    };
    const plan: LegacyConfigPullPlan = {
      writes: [{ change, documentPath: change.path, value: "000000" }],
      skipped: [],
      warnings: [],
      createdTable: undefined,
    };
    const text = legacyRenderConfigPullText(changeSet, { present: [], missing: [] }, plan);
    expect(text).toContain(
      "auth.sms.test_otp.hostile No config differences found. [remote_only, write]",
    );
  });
});
