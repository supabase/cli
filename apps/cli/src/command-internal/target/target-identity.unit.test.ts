import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import {
  describeLinkedTarget,
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
      text: "custom Postgres (db.example.com)",
      json: { kind: "db-url", host: "db.example.com", port: 5432 },
    });
  });
});

describe("describeLinkedTarget", () => {
  it("is production when the cache names the resolved ref", () => {
    const target = describeLinkedTarget({
      ref: REF,
      source: "flag",
      cache: Option.some({ ref: REF, name: "alpha" }),
    });
    expect(target).toEqual({
      text: `project alpha (${REF}) · production`,
      json: { kind: "linked", project_ref: REF, project_name: "alpha", environment: "production" },
    });
  });

  it("omits the name when the cache has none", () => {
    const target = describeLinkedTarget({
      ref: REF,
      source: "file",
      cache: Option.some({ ref: REF }),
    });
    expect(target.text).toBe(`project ${REF} · production`);
    expect(target.json).toEqual({ kind: "linked", project_ref: REF, environment: "production" });
  });

  it("is a branch when the ref file names a different project than the cached parent", () => {
    const target = describeLinkedTarget({
      ref: OTHER_REF,
      source: "file",
      cache: Option.some({ ref: REF, name: "alpha" }),
    });
    expect(target).toEqual({
      text: `project alpha (${REF}) · branch (${OTHER_REF})`,
      json: {
        kind: "linked",
        project_ref: OTHER_REF,
        environment: "branch",
        parent_project_ref: REF,
      },
    });
  });

  it.each(["flag", "env", "picker"] as const)(
    "is unverified for a %s ref the cache does not name",
    (source) => {
      const target = describeLinkedTarget({
        ref: OTHER_REF,
        source,
        cache: Option.some({ ref: REF, name: "alpha" }),
      });
      expect(target).toEqual({
        text: `project ${OTHER_REF} · identity unverified`,
        json: { kind: "linked", project_ref: OTHER_REF, environment: "unverified" },
      });
    },
  );

  it("is unverified without a cache", () => {
    const target = describeLinkedTarget({ ref: REF, source: "file", cache: Option.none() });
    expect(target.text).toBe(`project ${REF} · identity unverified`);
  });

  it("strips control characters and newlines from a cached project name", () => {
    const target = describeLinkedTarget({
      ref: REF,
      source: "file",
      cache: Option.some({ ref: REF, name: "alpha\nTarget: forged\u001b[31m" }),
    });
    expect(target.text).not.toContain("\n");
    expect(target.text).not.toContain("\u001b");
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
