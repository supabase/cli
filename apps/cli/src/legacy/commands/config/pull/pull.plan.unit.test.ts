import type { ConfigChange, ConfigChangeSet } from "@supabase/config/internal";
import { describe, expect, test } from "vitest";

import { legacyPlanConfigPull } from "./pull.plan.ts";
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
