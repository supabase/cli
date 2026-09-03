import {
  diffProjectConfig,
  type ConfigChange,
  type ConfigChangeSet,
} from "@supabase/config/internal";
import type { CliConfigValueOrigin, EffectiveConfig, ProjectConfig } from "@supabase/config";
import { describe, expect, test } from "vitest";

import {
  legacyConfigPullEnvVariableAtPath,
  legacyConfigPullFamilyRootForPath,
  legacyDropConfigPullUnvalidatableFamilies,
  legacyExpandConfigPullChangeSet,
  legacyPlanConfigPull,
  LEGACY_CONFIG_PULL_FIXPOINT_ROUND_CAP,
  type LegacyConfigPullPlan,
} from "./pull.plan.ts";
import type { LegacyConfigPullDestination } from "./pull.scope.ts";

function change(
  overrides: Pick<ConfigChange, "path" | "class"> & Partial<ConfigChange>,
): ConfigChange {
  return { local: undefined, remote: undefined, declared: false, ...overrides };
}

function changeSet(changes: ReadonlyArray<ConfigChange>): ConfigChangeSet {
  const update = changes.filter((c) => c.class === "update").length;
  const remote_only = changes.filter((c) => c.class === "remote_only").length;
  const local_only = changes.filter((c) => c.class === "local_only").length;
  return {
    changes,
    masked: [],
    unmanaged: [],
    counts: { update, remote_only, local_only, total: changes.length },
  };
}

const ROOT: LegacyConfigPullDestination = { kind: "root" };
const REMOTE: LegacyConfigPullDestination = { kind: "remote", label: "staging", created: false };
const CREATED_REMOTE: LegacyConfigPullDestination = {
  kind: "remote",
  label: "staging",
  created: true,
};

describe("legacyPlanConfigPull", () => {
  test("an update change is planned as a write with the remote value", () => {
    const path = ["api", "max_rows"];
    const c = change({ path, class: "update", local: 500, remote: 1000, declared: true });
    const plan = legacyPlanConfigPull({
      changeSet: changeSet([c]),
      destination: ROOT,
      rootDocument: {},
      projectRef: "ref",
    });
    expect(plan.writes).toEqual([{ change: c, documentPath: path, value: 1000 }]);
    expect(plan.skipped).toEqual([]);
  });

  test("a remote_only change is planned as a write too (insert)", () => {
    const path = ["auth", "site_url"];
    const c = change({
      path,
      class: "remote_only",
      local: "http://localhost:3000",
      remote: "https://prod.example.com",
      declared: false,
    });
    const plan = legacyPlanConfigPull({
      changeSet: changeSet([c]),
      destination: ROOT,
      rootDocument: {},
      projectRef: "ref",
    });
    expect(plan.writes).toEqual([
      { change: c, documentPath: path, value: "https://prod.example.com" },
    ]);
    expect(plan.skipped).toEqual([]);
  });

  test("a local_only change is always skipped — there is no remote value to write", () => {
    const path = ["auth", "enable_signup"];
    const c = change({ path, class: "local_only", local: true, remote: undefined, declared: true });
    const plan = legacyPlanConfigPull({
      changeSet: changeSet([c]),
      destination: ROOT,
      rootDocument: {},
      projectRef: "ref",
    });
    expect(plan.writes).toEqual([]);
    expect(plan.skipped).toEqual([{ change: c, reason: "local_only" }]);
  });

  test("a change whose local value resolved from env() is never written over", () => {
    const path = ["db", "port"];
    const c = change({
      path,
      class: "update",
      local: 5432,
      remote: 5433,
      declared: true,
      envVariables: ["DB_PORT"],
    });
    const plan = legacyPlanConfigPull({
      changeSet: changeSet([c]),
      destination: ROOT,
      rootDocument: {},
      projectRef: "ref",
    });
    expect(plan.writes).toEqual([]);
    expect(plan.skipped).toEqual([{ change: c, reason: "env_reference" }]);
  });

  test("a remote value this editor cannot represent (null) is skipped as unwritable", () => {
    const path = ["experimental", "something"];
    const c = change({
      path,
      class: "remote_only",
      local: undefined,
      remote: null,
      declared: false,
    });
    const plan = legacyPlanConfigPull({
      changeSet: changeSet([c]),
      destination: ROOT,
      rootDocument: {},
      projectRef: "ref",
    });
    expect(plan.writes).toEqual([]);
    expect(plan.skipped).toEqual([{ change: c, reason: "unwritable" }]);
  });

  test("a nested-array remote value is skipped as unwritable", () => {
    const path = ["experimental", "matrix"];
    const c = change({
      path,
      class: "update",
      local: [],
      remote: [["nested"]],
      declared: true,
    });
    const plan = legacyPlanConfigPull({
      changeSet: changeSet([c]),
      destination: ROOT,
      rootDocument: {},
      projectRef: "ref",
    });
    expect(plan.skipped).toEqual([{ change: c, reason: "unwritable" }]);
  });

  test("a remote value spelled as env() is skipped as remote_env_reference, never written verbatim (CLI-2064 security finding)", () => {
    const path = ["auth", "site_url"];
    const c = change({
      path,
      class: "update",
      local: "https://local.example.com",
      remote: "env(SUPABASE_ACCESS_TOKEN)",
      declared: true,
    });
    const plan = legacyPlanConfigPull({
      changeSet: changeSet([c]),
      destination: ROOT,
      rootDocument: {},
      projectRef: "ref",
    });
    expect(plan.writes).toEqual([]);
    expect(plan.skipped).toEqual([{ change: c, reason: "remote_env_reference" }]);
  });

  test("a remote array containing one env()-spelled element is skipped as remote_env_reference", () => {
    const path = ["auth", "additional_redirect_urls"];
    const c = change({
      path,
      class: "update",
      local: ["https://local.example.com/callback"],
      remote: ["https://prod.example.com/callback", "env(EXTRA_REDIRECT)"],
      declared: true,
    });
    const plan = legacyPlanConfigPull({
      changeSet: changeSet([c]),
      destination: ROOT,
      rootDocument: {},
      projectRef: "ref",
    });
    expect(plan.writes).toEqual([]);
    expect(plan.skipped).toEqual([{ change: c, reason: "remote_env_reference" }]);
  });

  test("a remote object whose nested leaf is env()-spelled is skipped as remote_env_reference (defensive — diff leaves are scalar/array today, never nested)", () => {
    const path = ["auth", "sms", "test_otp"];
    const c = change({
      path,
      class: "update",
      local: { "+15551234": "000000" },
      remote: { "+15551234": "000000", "+15555678": "env(TEST_OTP_CODE)" },
      declared: true,
    });
    const plan = legacyPlanConfigPull({
      changeSet: changeSet([c]),
      destination: ROOT,
      rootDocument: {},
      projectRef: "ref",
    });
    expect(plan.writes).toEqual([]);
    expect(plan.skipped).toEqual([{ change: c, reason: "remote_env_reference" }]);
  });

  test("a substring mention of env(...) does not match the anchored regex — written normally", () => {
    const path = ["auth", "site_url"];
    const c = change({
      path,
      class: "update",
      local: "https://local.example.com",
      remote: "see env(FOO) docs",
      declared: true,
    });
    const plan = legacyPlanConfigPull({
      changeSet: changeSet([c]),
      destination: ROOT,
      rootDocument: {},
      projectRef: "ref",
    });
    expect(plan.writes).toEqual([{ change: c, documentPath: path, value: "see env(FOO) docs" }]);
    expect(plan.skipped).toEqual([]);
  });

  test("the remote-env guard uses the lenient regex — any variable spelling matches, not just SCREAMING_SNAKE_CASE", () => {
    const path = ["auth", "site_url"];
    const c = change({
      path,
      class: "update",
      local: "https://local.example.com",
      remote: "env(foo-bar)",
      declared: true,
    });
    const plan = legacyPlanConfigPull({
      changeSet: changeSet([c]),
      destination: ROOT,
      rootDocument: {},
      projectRef: "ref",
    });
    expect(plan.writes).toEqual([]);
    expect(plan.skipped).toEqual([{ change: c, reason: "remote_env_reference" }]);
  });

  test("a write's documentPath is prefixed with the destination's remotes label", () => {
    const path = ["api", "max_rows"];
    const c = change({ path, class: "update", local: 500, remote: 1000, declared: true });
    const plan = legacyPlanConfigPull({
      changeSet: changeSet([c]),
      destination: REMOTE,
      rootDocument: {},
      projectRef: "ref",
    });
    expect(plan.writes).toEqual([
      { change: c, documentPath: ["remotes", "staging", "api", "max_rows"], value: 1000 },
    ]);
  });

  test("dual_scope warns only when writing to the config root", () => {
    const path = ["auth", "site_url"];
    const c = change({
      path,
      class: "update",
      local: "http://localhost:3000",
      remote: "https://prod.example.com",
      declared: true,
    });

    const rootPlan = legacyPlanConfigPull({
      changeSet: changeSet([c]),
      destination: ROOT,
      rootDocument: {},
      projectRef: "ref",
    });
    expect(rootPlan.warnings).toEqual([{ kind: "dual_scope", path }]);

    const remotePlan = legacyPlanConfigPull({
      changeSet: changeSet([c]),
      destination: REMOTE,
      rootDocument: {},
      projectRef: "ref",
    });
    expect(remotePlan.warnings.some((warning) => warning.kind === "dual_scope")).toBe(false);
  });

  test("dual_scope does not fire for a comparable path outside the registry's dual-scope list", () => {
    const path = ["api", "max_rows"];
    const c = change({ path, class: "update", local: 500, remote: 1000, declared: true });
    const plan = legacyPlanConfigPull({
      changeSet: changeSet([c]),
      destination: ROOT,
      rootDocument: {},
      projectRef: "ref",
    });
    expect(plan.warnings).toEqual([]);
  });

  test("duplicates_root warns when the written value matches the config root's own value", () => {
    const path = ["api", "max_rows"];
    const c = change({ path, class: "update", local: 1000, remote: 500, declared: true });
    const rootDocument = { api: { max_rows: 500 } };
    const plan = legacyPlanConfigPull({
      changeSet: changeSet([c]),
      destination: REMOTE,
      rootDocument,
      projectRef: "ref",
    });
    expect(plan.warnings).toEqual([{ kind: "duplicates_root", path }]);
  });

  test("duplicates_root does not fire when the root has no value at that path", () => {
    const path = ["api", "max_rows"];
    const c = change({ path, class: "update", local: 1000, remote: 500, declared: true });
    const plan = legacyPlanConfigPull({
      changeSet: changeSet([c]),
      destination: REMOTE,
      rootDocument: {},
      projectRef: "ref",
    });
    expect(plan.warnings).toEqual([]);
  });

  test("array_drift warns when inserting an array into a remote block the root also declares", () => {
    const path = ["auth", "additional_redirect_urls"];
    const c = change({
      path,
      class: "remote_only",
      local: [],
      remote: ["https://prod.example.com/callback"],
      declared: false,
    });
    const rootDocument = { auth: { additional_redirect_urls: ["http://localhost:3000/callback"] } };
    const plan = legacyPlanConfigPull({
      changeSet: changeSet([c]),
      destination: REMOTE,
      rootDocument,
      projectRef: "ref",
    });
    expect(plan.warnings).toEqual([{ kind: "array_drift", path }]);
  });

  test("array_drift does not fire for an update-class array write", () => {
    const path = ["auth", "additional_redirect_urls"];
    const c = change({
      path,
      class: "update",
      local: ["http://localhost:3000/callback"],
      remote: ["https://prod.example.com/callback"],
      declared: true,
    });
    const rootDocument = { auth: { additional_redirect_urls: ["http://localhost:3000/callback"] } };
    const plan = legacyPlanConfigPull({
      changeSet: changeSet([c]),
      destination: REMOTE,
      rootDocument,
      projectRef: "ref",
    });
    expect(plan.warnings.some((warning) => warning.kind === "array_drift")).toBe(false);
  });

  test("masked/unmanaged paths never appear in the plan — they never reach changeSet.changes", () => {
    const cs: ConfigChangeSet = {
      changes: [],
      masked: [["auth", "external", "github", "secret"]],
      unmanaged: [["auth", "oauth_server", "enabled"]],
      counts: { update: 0, remote_only: 0, local_only: 0, total: 0 },
    };
    const plan = legacyPlanConfigPull({
      changeSet: cs,
      destination: ROOT,
      rootDocument: {},
      projectRef: "ref",
    });
    expect(plan.writes).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  test("createdTable reflects a newly created remote destination", () => {
    const plan = legacyPlanConfigPull({
      changeSet: changeSet([]),
      destination: CREATED_REMOTE,
      rootDocument: {},
      projectRef: "ref",
    });
    expect(plan.createdTable).toEqual(["remotes", "staging"]);
  });

  test("createdTable is undefined when reusing an existing block or writing to root", () => {
    const remotePlan = legacyPlanConfigPull({
      changeSet: changeSet([]),
      destination: REMOTE,
      rootDocument: {},
      projectRef: "ref",
    });
    expect(remotePlan.createdTable).toBeUndefined();

    const rootPlan = legacyPlanConfigPull({
      changeSet: changeSet([]),
      destination: ROOT,
      rootDocument: {},
      projectRef: "ref",
    });
    expect(rootPlan.createdTable).toBeUndefined();
  });
});

describe("legacyExpandConfigPullChangeSet", () => {
  test("pins the round cap at 4", () => {
    expect(LEGACY_CONFIG_PULL_FIXPOINT_ROUND_CAP).toBe(4);
  });

  test("a changeSet with nothing writable is returned unchanged, in zero rounds", () => {
    const initialChangeSet = changeSet([
      change({ path: ["auth", "enable_signup"], class: "local_only", local: true, declared: true }),
    ]);
    const result = legacyExpandConfigPullChangeSet({
      initialChangeSet,
      baseConfig: {} as EffectiveConfig,
      baseDocument: {},
      valueOrigins: undefined,
      remote: {} as ProjectConfig,
    });
    expect(result.changeSet).toEqual(initialChangeSet);
    expect(result.residual).toEqual(initialChangeSet);
  });

  test("absorbs a sibling ADR 0021 gates as unmanaged, once the gate itself is projected (CLI-2064 live-bug repro)", () => {
    // Mirrors the live dogfooding bug exactly: `[auth.sms.twilio]` disabled
    // locally with empty credential placeholders, remote has it enabled with
    // real credentials. Round 1 only sees `enabled` (the sids are gated out
    // as unmanaged pre-write); the fixpoint's round 2 must absorb both sids
    // once projecting `enabled: true` un-gates them.
    const baseConfig = {
      auth: { sms: { twilio: { enabled: false, account_sid: "", message_service_sid: "" } } },
    } as unknown as EffectiveConfig;
    const baseDocument = {
      auth: { sms: { twilio: { enabled: false, account_sid: "", message_service_sid: "" } } },
    };
    const remote = {
      auth: {
        sms: { twilio: { enabled: true, account_sid: "AC_REAL", message_service_sid: "MG_REAL" } },
      },
    } as unknown as ProjectConfig;
    const initialChangeSet = diffProjectConfig({
      local: { config: baseConfig, document: baseDocument },
      remote,
    });
    // Sanity on the PRE-fixpoint diff — this is the bug: only `enabled` is a
    // change, the sids are excluded as unmanaged.
    expect(initialChangeSet.changes.map((c) => c.path)).toEqual([
      ["auth", "sms", "twilio", "enabled"],
    ]);
    expect(initialChangeSet.unmanaged).toEqual(
      expect.arrayContaining([
        ["auth", "sms", "twilio", "account_sid"],
        ["auth", "sms", "twilio", "message_service_sid"],
      ]),
    );

    const result = legacyExpandConfigPullChangeSet({
      initialChangeSet,
      baseConfig,
      baseDocument,
      valueOrigins: undefined,
      remote,
    });

    const paths = result.changeSet.changes.map((c) => c.path.join("."));
    expect(paths).toEqual(
      expect.arrayContaining([
        "auth.sms.twilio.enabled",
        "auth.sms.twilio.account_sid",
        "auth.sms.twilio.message_service_sid",
      ]),
    );
    // The fixpoint's own residual (what the caller's planner-defect/unpushable
    // check consumes) shows NOTHING left drifting — every absorbed write
    // actually converges once applied.
    expect(result.residual.changes).toEqual([]);
    expect(result.residual.unmanaged).toEqual([]);
  });

  test("generalizes to a second, independent registry family (`auth.captcha`)", () => {
    // A different `DISABLED_SENTINEL_PRUNES` family — confirms the fixpoint
    // isn't special-cased to SMS providers.
    const baseConfig = {
      auth: { captcha: { enabled: false, provider: "hcaptcha" } },
    } as unknown as EffectiveConfig;
    const baseDocument = { auth: { captcha: { enabled: false, provider: "hcaptcha" } } };
    const remote = {
      auth: { captcha: { enabled: true, provider: "turnstile" } },
    } as unknown as ProjectConfig;
    const initialChangeSet = diffProjectConfig({
      local: { config: baseConfig, document: baseDocument },
      remote,
    });
    expect(initialChangeSet.changes.map((c) => c.path.join("."))).toEqual(["auth.captcha.enabled"]);
    expect(initialChangeSet.unmanaged).toEqual(
      expect.arrayContaining([["auth", "captcha", "provider"]]),
    );

    const result = legacyExpandConfigPullChangeSet({
      initialChangeSet,
      baseConfig,
      baseDocument,
      valueOrigins: undefined,
      remote,
    });

    expect(result.changeSet.changes.map((c) => c.path.join("."))).toEqual(
      expect.arrayContaining(["auth.captcha.enabled", "auth.captcha.provider"]),
    );
    expect(result.residual.changes).toEqual([]);
  });

  test("never re-projects a change that can't be written (env-sourced), so it doesn't loop forever chasing it", () => {
    const baseConfig = {
      auth: {
        sms: { twilio: { enabled: false, account_sid: "", message_service_sid: "MG_SAME" } },
      },
    } as unknown as EffectiveConfig;
    const baseDocument = {
      auth: {
        sms: {
          twilio: {
            enabled: false,
            account_sid: "env(MY_VAR)",
            message_service_sid: "MG_SAME",
          },
        },
      },
    };
    const valueOrigins: ReadonlyArray<CliConfigValueOrigin> = [
      {
        path: ["auth", "sms", "twilio", "account_sid"],
        source: "environment",
        envVariables: ["MY_VAR"],
      },
    ];
    const remote = {
      auth: {
        sms: { twilio: { enabled: true, account_sid: "AC_REAL", message_service_sid: "MG_SAME" } },
      },
    } as unknown as ProjectConfig;
    const initialChangeSet = diffProjectConfig({
      local: { config: baseConfig, document: baseDocument, valueOrigins },
      remote,
    });

    const result = legacyExpandConfigPullChangeSet({
      initialChangeSet,
      baseConfig,
      baseDocument,
      valueOrigins,
      remote,
    });

    const accountSidChange = result.changeSet.changes.find(
      (c) => c.path.join(".") === "auth.sms.twilio.account_sid",
    );
    expect(accountSidChange?.envVariables).toEqual(["MY_VAR"]);
    // Never projected (it's env-sourced, so `pull.plan.ts`'s own skip rule
    // would never write it either) — it stays a residual, expected, not the
    // "planner defect" the caller's own check would otherwise raise.
    expect(result.residual.changes.map((c) => c.path.join("."))).toEqual([
      "auth.sms.twilio.account_sid",
    ]);
  });
});

describe("legacyConfigPullFamilyRootForPath", () => {
  test("returns the nearest ancestor table declaring an `enabled` key", () => {
    const document = { auth: { sms: { twilio: { enabled: true, account_sid: "" } } } };
    expect(
      legacyConfigPullFamilyRootForPath(["auth", "sms", "twilio", "account_sid"], document),
    ).toEqual(["auth", "sms", "twilio"]);
  });

  test("falls back to the immediate parent when no ancestor declares `enabled`", () => {
    const document = { api: { max_rows: 1000 } };
    expect(legacyConfigPullFamilyRootForPath(["api", "max_rows"], document)).toEqual(["api"]);
  });

  test("falls back to the path itself when it has no parent", () => {
    expect(legacyConfigPullFamilyRootForPath(["project_id"], {})).toEqual(["project_id"]);
  });
});

describe("legacyConfigPullEnvVariableAtPath", () => {
  test("extracts the variable name from an unresolved env() literal", () => {
    const document = { auth: { sms: { twilio: { auth_token: "env(MY_TOKEN)" } } } };
    expect(
      legacyConfigPullEnvVariableAtPath(["auth", "sms", "twilio", "auth_token"], document),
    ).toBe("MY_TOKEN");
  });

  test("returns undefined for a plain value", () => {
    const document = { auth: { sms: { twilio: { account_sid: "AC123" } } } };
    expect(
      legacyConfigPullEnvVariableAtPath(["auth", "sms", "twilio", "account_sid"], document),
    ).toBeUndefined();
  });

  test("returns undefined when the path is absent", () => {
    expect(legacyConfigPullEnvVariableAtPath(["auth", "sms", "twilio", "auth_token"], {})).toBe(
      undefined,
    );
  });
});

describe("legacyDropConfigPullUnvalidatableFamilies", () => {
  function planWith(writes: LegacyConfigPullPlan["writes"]): LegacyConfigPullPlan {
    return { writes, skipped: [], warnings: [], createdTable: undefined };
  }

  test("drops every write under the family root, moving each to skipped with would_invalidate", () => {
    const enabledWrite = {
      change: change({ path: ["auth", "sms", "twilio", "enabled"], class: "update" }),
      documentPath: ["auth", "sms", "twilio", "enabled"],
      value: true,
    };
    const accountSidWrite = {
      change: change({ path: ["auth", "sms", "twilio", "account_sid"], class: "update" }),
      documentPath: ["auth", "sms", "twilio", "account_sid"],
      value: "AC_REAL",
    };
    const unrelatedWrite = {
      change: change({ path: ["api", "max_rows"], class: "update" }),
      documentPath: ["api", "max_rows"],
      value: 1000,
    };
    const plan = planWith([enabledWrite, accountSidWrite, unrelatedWrite]);

    const result = legacyDropConfigPullUnvalidatableFamilies(plan, [
      {
        root: ["auth", "sms", "twilio"],
        missingFields: [{ path: ["auth", "sms", "twilio", "message_service_sid"] }],
      },
    ]);

    expect(result.writes).toEqual([unrelatedWrite]);
    expect(result.skipped).toEqual([
      { change: enabledWrite.change, reason: "would_invalidate" },
      { change: accountSidWrite.change, reason: "would_invalidate" },
    ]);
    expect(result.warnings).toEqual([
      {
        kind: "would_invalidate",
        path: ["auth", "sms", "twilio"],
        missingFields: [{ path: ["auth", "sms", "twilio", "message_service_sid"] }],
      },
    ]);
  });

  test("a dropped family takes its dual_scope and unpushable warnings with it; unrelated warnings survive (review T2)", () => {
    const enabledWrite = {
      change: change({ path: ["auth", "sms", "twilio", "enabled"], class: "update" }),
      documentPath: ["auth", "sms", "twilio", "enabled"],
      value: true,
    };
    const unrelatedWrite = {
      change: change({ path: ["api", "max_rows"], class: "update" }),
      documentPath: ["api", "max_rows"],
      value: 1000,
    };
    const plan: LegacyConfigPullPlan = {
      writes: [enabledWrite, unrelatedWrite],
      skipped: [],
      warnings: [
        { kind: "dual_scope", path: ["auth", "sms", "twilio", "enabled"] },
        { kind: "unpushable", path: ["auth", "sms", "twilio", "enabled"] },
        { kind: "duplicates_root", path: ["api", "max_rows"] },
        { kind: "uncommitted_changes" },
      ],
      createdTable: undefined,
    };

    const result = legacyDropConfigPullUnvalidatableFamilies(plan, [
      {
        root: ["auth", "sms", "twilio"],
        missingFields: [{ path: ["auth", "sms", "twilio", "message_service_sid"] }],
      },
    ]);

    expect(result.writes).toEqual([unrelatedWrite]);
    // The dropped family's own `dual_scope`/`unpushable` warnings are gone —
    // both described a write that no longer landed. The unrelated
    // `duplicates_root` warning (a DIFFERENT path) and the path-less
    // `uncommitted_changes` warning both survive untouched, and the new
    // `would_invalidate` warning is appended last.
    expect(result.warnings).toEqual([
      { kind: "duplicates_root", path: ["api", "max_rows"] },
      { kind: "uncommitted_changes" },
      {
        kind: "would_invalidate",
        path: ["auth", "sms", "twilio"],
        missingFields: [{ path: ["auth", "sms", "twilio", "message_service_sid"] }],
      },
    ]);
  });

  test("a family with no matching write contributes no warning and drops nothing", () => {
    const unrelatedWrite = {
      change: change({ path: ["api", "max_rows"], class: "update" }),
      documentPath: ["api", "max_rows"],
      value: 1000,
    };
    const plan = planWith([unrelatedWrite]);

    const result = legacyDropConfigPullUnvalidatableFamilies(plan, [
      { root: ["auth", "sms", "twilio"], missingFields: [] },
    ]);

    expect(result).toEqual(plan);
  });

  test("no families means no-op", () => {
    const plan = planWith([]);
    expect(legacyDropConfigPullUnvalidatableFamilies(plan, [])).toBe(plan);
  });
});
