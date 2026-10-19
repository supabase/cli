import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import {
  describeLinkedTarget,
  linkedAlternativeHint,
  renderBranchTarget,
  renderDbUrlTarget,
  renderLocalTarget,
} from "./target-identity.ts";

const REF = "abcdefghijklmnopqrst";
const OTHER_REF = "qrstuvwxyzabcdefghij";

describe("renderLocalTarget", () => {
  it("renders the host and port", () => {
    expect(renderLocalTarget("127.0.0.1", 54322)).toEqual({
      text: "local stack (127.0.0.1:54322)",
      json: { kind: "local", host: "127.0.0.1", port: 54322 },
    });
  });

  it("brackets an IPv6 host", () => {
    expect(renderLocalTarget("::1", 54322).text).toBe("local stack ([::1]:54322)");
  });
});

describe("renderDbUrlTarget", () => {
  it("names the host without credentials", () => {
    expect(renderDbUrlTarget("db.example.com", 5432)).toEqual({
      text: "custom Postgres (db.example.com:5432)",
      json: { kind: "db-url", host: "db.example.com", port: 5432 },
    });
  });
});

describe("describeLinkedTarget", () => {
  it("is production when the cache names the resolved ref", () => {
    const target = describeLinkedTarget({
      ref: REF,
      cache: Option.some({ ref: REF, name: "alpha" }),
    });
    expect(target).toEqual({
      text: `project alpha (${REF}) · production`,
      json: { kind: "linked", project_ref: REF, project_name: "alpha", environment: "production" },
    });
  });

  it("omits the name when the cache has none", () => {
    const target = describeLinkedTarget({ ref: REF, cache: Option.some({ ref: REF }) });
    expect(target.text).toBe(`project ${REF} · production`);
    expect(target.json).toEqual({ kind: "linked", project_ref: REF, environment: "production" });
  });

  it("never claims a branch for a ref the cache does not name", () => {
    const target = describeLinkedTarget({
      ref: OTHER_REF,
      cache: Option.some({ ref: REF, name: "alpha" }),
    });
    expect(target).toEqual({
      text: `project ${OTHER_REF}`,
      json: { kind: "linked", project_ref: OTHER_REF, environment: "unverified" },
    });
  });

  it("is just the ref without a cache", () => {
    const target = describeLinkedTarget({ ref: REF, cache: Option.none() });
    expect(target.text).toBe(`project ${REF}`);
  });

  it("says a ref that differs from the linked project is not the linked project", () => {
    const target = describeLinkedTarget({
      ref: OTHER_REF,
      cache: Option.some({ ref: REF, name: "alpha" }),
      linkedRef: Option.some(REF),
    });
    expect(target.text).toBe(`project ${OTHER_REF} (not the linked project)`);
    expect(target.json).toEqual({
      kind: "linked",
      project_ref: OTHER_REF,
      environment: "unverified",
    });
  });

  it("does not flag the linked ref itself", () => {
    const target = describeLinkedTarget({
      ref: REF,
      cache: Option.none(),
      linkedRef: Option.some(REF),
    });
    expect(target.text).toBe(`project ${REF}`);
  });

  it("does not flag a ref when nothing is linked", () => {
    const target = describeLinkedTarget({
      ref: REF,
      cache: Option.none(),
      linkedRef: Option.none(),
    });
    expect(target.text).toBe(`project ${REF}`);
  });

  it("shows the project name the picker gave", () => {
    const target = describeLinkedTarget({
      ref: OTHER_REF,
      cache: Option.none(),
      name: "beta",
      linkedRef: Option.some(REF),
    });
    expect(target).toEqual({
      text: `project beta (${OTHER_REF}) (not the linked project)`,
      json: {
        kind: "linked",
        project_ref: OTHER_REF,
        project_name: "beta",
        environment: "unverified",
      },
    });
  });

  it("strips control characters and newlines from a cached project name", () => {
    const target = describeLinkedTarget({
      ref: REF,
      cache: Option.some({ ref: REF, name: "alpha\nTarget: forged\u001b[31m" }),
    });
    expect(target.text).not.toContain("\n");
    expect(target.text).not.toContain("\u001b");
  });
});

describe("linkedAlternativeHint", () => {
  it("names the cached project when the cache matches the linked ref", () => {
    expect(
      linkedAlternativeHint({ ref: REF, cache: Option.some({ ref: REF, name: "alpha" }) }),
    ).toBe(`default; pass --remote for alpha (${REF})`);
  });

  it("falls back to the ref when the cache is absent or names another project", () => {
    const expected = `default; pass --remote for ${REF}`;
    expect(linkedAlternativeHint({ ref: REF, cache: Option.none() })).toBe(expected);
    expect(
      linkedAlternativeHint({ ref: REF, cache: Option.some({ ref: OTHER_REF, name: "beta" }) }),
    ).toBe(expected);
  });
});

describe("renderBranchTarget", () => {
  it("names the parent, branch and resolved ref for a name lookup", () => {
    const target = renderBranchTarget({
      branch: Option.some("feature-x"),
      ref: OTHER_REF,
      parentRef: Option.some(REF),
    });
    expect(target).toEqual({
      text: `project ${REF} · branch feature-x (${OTHER_REF})`,
      json: {
        kind: "linked",
        project_ref: OTHER_REF,
        environment: "branch",
        parent_project_ref: REF,
      },
    });
  });

  it("shows only the resolved ref for a UUID lookup", () => {
    const target = renderBranchTarget({
      branch: Option.none(),
      ref: OTHER_REF,
      parentRef: Option.none(),
    });
    expect(target).toEqual({
      text: `branch ${OTHER_REF}`,
      json: { kind: "linked", project_ref: OTHER_REF, environment: "branch" },
    });
  });
});
