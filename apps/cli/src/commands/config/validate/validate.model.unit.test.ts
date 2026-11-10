import { describe, expect, it } from "vitest";

import {
  type ConfigProblem,
  dedupeProblems,
  envReferences,
  isPublicValuePath,
  nearestEnabledGate,
  splitRemotePath,
  withoutFollowOns,
  withoutUnresolvedEnvErrors,
} from "./validate.model.ts";

const problem = (fields: Partial<ConfigProblem> & Pick<ConfigProblem, "code">): ConfigProblem => ({
  severity: "error",
  reason: "bad",
  showValue: false,
  ...fields,
});

const noRemoteWrites = () => false;

describe("splitRemotePath", () => {
  it("separates the remote name from the path inside the remote", () => {
    expect(splitRemotePath(["remotes", "staging", "db", "port"])).toEqual({
      remote: "staging",
      path: ["db", "port"],
    });
  });

  it("leaves a base path alone", () => {
    expect(splitRemotePath(["db", "port"])).toEqual({ path: ["db", "port"] });
  });
});

describe("isPublicValuePath", () => {
  it.each([
    "db.port",
    "db.major_version",
    "auth.external.github.client_id",
    "remotes.staging.db.port",
  ])("shows the value of %s", (path) => {
    expect(isPublicValuePath(path.split("."))).toBe(true);
  });

  it.each([
    "db.root_key",
    "db.vault.token",
    "edge_runtime.secrets.API_KEY",
    "auth.external.github.secret",
    "auth.email.smtp.pass",
    "auth.hook.send_email.secrets",
    "api.not_a_key",
  ])("masks the value of %s", (path) => {
    expect(isPublicValuePath(path.split("."))).toBe(false);
  });

  it("keeps segment boundaries, so a quoted dotted key is not the nested path", () => {
    expect(isPublicValuePath(["db.port"])).toBe(false);
    expect(isPublicValuePath(["db", "port"])).toBe(true);
  });
});

describe("dedupeProblems", () => {
  it("drops a remote problem the base already reports", () => {
    const base = problem({
      code: "invalid_value",
      path: ["db", "port"],
      reason: "expected a port",
    });
    const remote = { ...base, remote: "staging" };
    expect(dedupeProblems([base, remote], noRemoteWrites)).toEqual([base]);
  });

  it("keeps a remote problem on a key the remote writes itself", () => {
    const base = problem({
      code: "invalid_value",
      path: ["db", "port"],
      reason: "expected a port",
    });
    const remote = { ...base, remote: "staging" };
    expect(
      dedupeProblems(
        [base, remote],
        (name, path) => name === "staging" && path.join(".") === "db.port",
      ),
    ).toEqual([base, remote]);
  });

  it("reports a value-level key once even when the reason differs", () => {
    const first = problem({ code: "invalid_value", path: ["db", "port"], reason: "one" });
    const second = problem({ code: "invalid_value", path: ["db", "port"], reason: "two" });
    expect(dedupeProblems([first, second], noRemoteWrites)).toEqual([first]);
  });

  it("keeps the same key reported under different remotes", () => {
    const a = problem({ code: "invalid_value", path: ["db", "port"], remote: "a" });
    const b = problem({ code: "invalid_value", path: ["db", "port"], remote: "b" });
    expect(dedupeProblems([a, b], (name) => name !== "")).toEqual([a, b]);
  });
});

describe("withoutFollowOns", () => {
  it("drops problems at or below a pruned path and keeps the rest", () => {
    const below = problem({
      code: "missing_required",
      path: ["auth", "external", "github", "client_id"],
    });
    const at = problem({ code: "invalid_value", path: ["auth", "external", "github"] });
    const other = problem({
      code: "invalid_value",
      path: ["auth", "external", "gitlab", "client_id"],
    });
    const pathless = problem({ code: "removed_env" });
    expect(
      withoutFollowOns([below, at, other, pathless], [["auth", "external", "github"]]),
    ).toEqual([other, pathless]);
  });
});

describe("envReferences", () => {
  it("finds whole-value references with their key path and remote", () => {
    const references = envReferences({
      auth: { site_url: "env(SITE)", note: "see env(IGNORED) here" },
      remotes: { prod: { api: { max_rows: "env(ROWS)" } } },
      list: ["env(FIRST)"],
    });

    expect(references).toEqual([
      { name: "SITE", path: ["auth", "site_url"] },
      { name: "ROWS", path: ["api", "max_rows"], remote: "prod" },
      { name: "FIRST", path: ["list", "0"] },
    ]);
  });
});

describe("withoutUnresolvedEnvErrors", () => {
  const baseRef = { name: "A", path: ["api"] };
  const remoteRef = { name: "B", path: ["api"], remote: "prod" };
  const referencesFor =
    (...references: ReadonlyArray<typeof baseRef | typeof remoteRef>) =>
    (remote: string | undefined) =>
      references.filter((reference) => Reflect.get(reference, "remote") === remote);

  it("drops value errors at or below an unresolved reference of the same pass", () => {
    const base = problem({ code: "invalid_value", path: ["api", "max_rows"] });
    const remote = problem({ code: "invalid_value", path: ["api", "max_rows"], remote: "prod" });
    const result = withoutUnresolvedEnvErrors([base, remote], referencesFor(baseRef));

    expect(result.kept).toEqual([remote]);
    expect(result.blamed).toEqual([{ reference: baseRef }]);
  });

  it("lets a remote reference drop only that remote's errors", () => {
    const base = problem({ code: "invalid_value", path: ["api", "max_rows"] });
    const remote = problem({ code: "invalid_value", path: ["api", "max_rows"], remote: "prod" });

    expect(withoutUnresolvedEnvErrors([base, remote], referencesFor(remoteRef)).kept).toEqual([
      base,
    ]);
  });

  it("keeps errors that are not about the value the reference stands for", () => {
    const unknown = problem({ code: "unknown_key", path: ["api", "prot"] });
    const removed = problem({ code: "removed_key", path: ["api", "old"] });
    const external = problem({ code: "invalid_value", path: ["api", "port"], external: true });
    const problems = [unknown, removed, external];

    expect(withoutUnresolvedEnvErrors(problems, referencesFor(baseRef)).kept).toEqual(problems);
  });

  it("never drops warnings", () => {
    const warning = problem({
      code: "deprecated_key",
      severity: "warning",
      path: ["api", "max_rows"],
    });
    expect(withoutUnresolvedEnvErrors([warning], referencesFor(baseRef)).kept).toEqual([warning]);
  });
});

describe("nearestEnabledGate", () => {
  const config = {
    auth: { enabled: true, external: { github: { enabled: false, secret: "x" } }, site_url: "u" },
    db: { port: 1 },
  };

  it("uses the nearest enclosing table that has an enabled switch", () => {
    expect(nearestEnabledGate([config], ["auth", "external", "github", "secret"])).toBe(false);
    expect(nearestEnabledGate([config], ["auth", "site_url"])).toBe(true);
  });

  it("prefers a nearer gate in any representation over a farther one", () => {
    const decoded = { auth: { enabled: true, external: {} } };
    const raw = { auth: { external: { myidp: { enabled: false } } } };
    expect(nearestEnabledGate([decoded, raw], ["auth", "external", "myidp", "secret"])).toBe(false);
  });

  it("is undefined when no enclosing table has one", () => {
    expect(nearestEnabledGate([config], ["db", "port"])).toBeUndefined();
    expect(nearestEnabledGate([undefined], ["db", "port"])).toBeUndefined();
  });
});
