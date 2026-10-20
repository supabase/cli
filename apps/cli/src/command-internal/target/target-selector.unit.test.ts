import { Option, Result } from "effect";
import { describe, expect, it } from "vitest";

import type { RemoteValue } from "./remote-value.ts";
import {
  hasExplicitSelector,
  parseTargetSelector,
  type TargetSelectorInput,
  type TargetSelectorOptions,
} from "./target-selector.ts";

const REF = "abcdefghijklmnopqrst";
const URL = "postgresql://u:p@db.example.com:5432/postgres";

const none: TargetSelectorInput = {
  remote: Option.none(),
  local: false,
  linked: false,
  dbUrl: Option.none(),
  projectRef: Option.none(),
};

const remote = (value: RemoteValue) => ({ remote: Option.some(value) });

const parse = (overrides: Partial<TargetSelectorInput>, options?: TargetSelectorOptions) =>
  parseTargetSelector({ ...none, ...overrides }, options);

const success = (overrides: Partial<TargetSelectorInput>) => {
  const result = parse(overrides);
  if (Result.isFailure(result))
    throw new Error(`expected the selector to be accepted: ${result.failure.message}`);
  return result.success;
};

const failure = (overrides: Partial<TargetSelectorInput>, options?: TargetSelectorOptions) => {
  const result = parse(overrides, options);
  if (Result.isSuccess(result)) throw new Error("expected the selector to be rejected");
  return result.failure;
};

describe("parseTargetSelector", () => {
  it("reports no explicit target and no deprecation when nothing is set", () => {
    expect(success({})).toEqual({ selection: { _tag: "Default" }, deprecations: [] });
  });

  describe("--remote", () => {
    it.each([
      ["a bare --remote", { _tag: "Linked" }, { _tag: "Linked" }],
      ["a project ref", { _tag: "Ref", ref: REF }, { _tag: "Ref", ref: REF }],
      ["a database URL", { _tag: "DbUrl", url: URL }, { _tag: "DbUrl", url: URL }],
      [
        "a branch name",
        { _tag: "Branch", name: "feature-x" },
        { _tag: "Branch", name: "feature-x" },
      ],
    ] as const)(
      "selects the target named by %s without a deprecation",
      (_name, value, selection) => {
        expect(success(remote(value))).toEqual({ selection, deprecations: [] });
      },
    );
  });

  describe("deprecated aliases", () => {
    it("treats --local as the default and reports it", () => {
      expect(success({ local: true })).toEqual({
        selection: { _tag: "Local" },
        deprecations: [{ kind: "local" }],
      });
    });

    it("maps --linked to a bare --remote", () => {
      expect(success({ linked: true })).toEqual({
        selection: { _tag: "Linked" },
        deprecations: [{ kind: "remote-alias", flags: ["--linked"], remote: { _tag: "Linked" } }],
      });
    });

    it("maps --db-url to --remote=<url>", () => {
      expect(success({ dbUrl: Option.some(URL) })).toEqual({
        selection: { _tag: "DbUrl", url: URL },
        deprecations: [
          { kind: "remote-alias", flags: ["--db-url"], remote: { _tag: "DbUrl", url: URL } },
        ],
      });
    });

    it.each(["--project-ref", "--project-id"] as const)(
      "maps %s with a ref to --remote=<ref>",
      (flag) => {
        const overrides =
          flag === "--project-ref"
            ? { projectRef: Option.some(REF) }
            : { projectId: Option.some(REF) };
        expect(success(overrides)).toEqual({
          selection: { _tag: "Ref", ref: REF },
          deprecations: [
            { kind: "remote-alias", flags: [flag], remote: { _tag: "Ref", ref: REF } },
          ],
        });
      },
    );

    it("maps --project-ref with a branch name to --remote=<branch>", () => {
      expect(success({ projectRef: Option.some("feature-x") })).toEqual({
        selection: { _tag: "Branch", name: "feature-x" },
        deprecations: [
          {
            kind: "remote-alias",
            flags: ["--project-ref"],
            remote: { _tag: "Branch", name: "feature-x" },
          },
        ],
      });
    });

    it("folds --linked and --project-ref into one deprecation", () => {
      expect(success({ linked: true, projectRef: Option.some(REF) })).toEqual({
        selection: { _tag: "Ref", ref: REF },
        deprecations: [
          {
            kind: "remote-alias",
            flags: ["--linked", "--project-ref"],
            remote: { _tag: "Ref", ref: REF },
          },
        ],
      });
    });

    it("lets a bare --remote agree with --project-ref", () => {
      expect(
        success({ ...remote({ _tag: "Linked" }), projectRef: Option.some(REF) }),
      ).toMatchObject({
        selection: { _tag: "Ref", ref: REF },
      });
    });

    it("treats false switches as absent", () => {
      expect(success({ local: false, linked: false })).toEqual({
        selection: { _tag: "Default" },
        deprecations: [],
      });
      expect(success({ linked: false, dbUrl: Option.some(URL) })).toMatchObject({
        selection: { _tag: "DbUrl", url: URL },
      });
    });
  });

  describe("alias values", () => {
    it.each([
      { flag: "--project-ref", overrides: { projectRef: Option.some("https://example.com") } },
      { flag: "--project-id", overrides: { projectId: Option.some("https://example.com") } },
    ] as const)("rejects a URL given to $flag", ({ flag, overrides }) => {
      expect(failure(overrides)).toMatchObject({
        _tag: "TargetInvalidValueError",
        flag,
        message: `${flag} takes a project ref or a branch name, not a URL.`,
        suggestion:
          "Pass a project ref or a branch name, for example --remote=abcdefghijklmnopqrst",
      });
    });

    it("rejects a keyword connection string given to --project-ref without echoing it", () => {
      const error = failure({ projectRef: Option.some("host=db.example.com password=hunter2") });
      expect(error).toMatchObject({
        _tag: "TargetInvalidValueError",
        flag: "--project-ref",
        message: "--project-ref takes a project ref or a branch name, not a connection string.",
      });
      expect(JSON.stringify(error)).not.toContain("hunter2");
    });

    it("suggests the ref a project URL already names", () => {
      expect(failure({ projectRef: Option.some(`https://${REF}.supabase.co`) })).toMatchObject({
        _tag: "TargetInvalidValueError",
        suggestion: `Use --remote=${REF}.`,
      });
    });

    it("trims an alias value before it is classified", () => {
      expect(success({ projectRef: Option.some(` ${REF} `) }).selection).toEqual({
        _tag: "Ref",
        ref: REF,
      });
    });

    it.each(["true", "False", "YES", "off", "1", "0"])(
      "keeps looking up a branch named %s through --project-ref",
      (name) => {
        expect(success({ projectRef: Option.some(name) }).selection).toEqual({
          _tag: "Branch",
          name,
        });
      },
    );

    it("keeps a keyword connection string given to --db-url working", () => {
      const dsn = "host=db.example.com user=postgres password=pw";
      expect(success({ dbUrl: Option.some(dsn) }).selection).toEqual({ _tag: "DbUrl", url: dsn });
    });

    it("treats a postgres URL in any case as a database", () => {
      expect(success({ projectRef: Option.some("POSTGRESQL://h/db") }).selection).toEqual({
        _tag: "DbUrl",
        url: "postgresql://h/db",
      });
    });
  });

  describe("conflicts", () => {
    it.each([
      ["--linked", { linked: true }, ["--remote", "--linked"]],
      ["--db-url", { dbUrl: Option.some(URL) }, ["--remote", "--db-url"]],
      ["--local", { local: true }, ["--remote", "--local"]],
    ] as const)("rejects --remote with %s and names both flags", (_flag, overrides, flags) => {
      expect(failure({ ...remote({ _tag: "Linked" }), ...overrides })).toMatchObject({
        _tag: "TargetSelectorConflictError",
        flags,
      });
    });

    it("lists every selector that was set, in a fixed order", () => {
      expect(
        failure({
          ...remote({ _tag: "Linked" }),
          local: true,
          linked: true,
          dbUrl: Option.some(URL),
        }),
      ).toMatchObject({
        _tag: "TargetSelectorConflictError",
        flags: ["--remote", "--linked", "--db-url", "--local"],
        message:
          "Only one of --remote, --linked, --db-url and --local can be set; got --remote, --linked, --db-url and --local.",
      });
    });

    it.each([
      { name: "with a database input", overrides: {}, hint: "<ref|branch|url>" },
      { name: "without one", overrides: { dbUrl: undefined }, hint: "<ref|branch>" },
    ])("rejects a --remote given twice with different values, $name", ({ overrides, hint }) => {
      expect(
        failure({ ...remote({ _tag: "Linked" }), ...overrides }, { remoteConflict: true }),
      ).toMatchObject({
        _tag: "TargetSelectorConflictError",
        flags: ["--remote"],
        message: "--remote is given more than once with different values; pass it once.",
        suggestion: `Pass --remote once, as --remote or --remote=${hint}.`,
      });
    });

    it("rejects --local with --linked", () => {
      expect(failure({ local: true, linked: true })).toMatchObject({
        flags: ["--linked", "--local"],
        message:
          "Only one of --remote, --linked, --db-url and --local can be set; got --linked and --local.",
      });
    });

    it.each([
      [
        "--local",
        { local: true },
        "--project-ref selects a remote project and cannot be combined with --local.",
      ],
      [
        "--db-url",
        { dbUrl: Option.some(URL) },
        "--project-ref selects a remote project and cannot be combined with --db-url.",
      ],
      [
        "--remote=<ref>",
        remote({ _tag: "Ref", ref: REF }),
        "--project-ref cannot be combined with --remote=<value>.",
      ],
    ] as const)("rejects --project-ref with %s", (_flag, overrides, message) => {
      expect(failure({ ...overrides, projectRef: Option.some(REF) })).toMatchObject({
        _tag: "TargetProjectRefConflictError",
        message,
      });
    });

    it.each([
      ["--local", { local: true }, "Use --remote=<ref> for the project, or leave both out"],
      [
        "--db-url",
        { dbUrl: Option.some(URL) },
        "Use --remote=<ref> for the project or --remote=<url> for the database, not both.",
      ],
      ["--remote=<ref>", remote({ _tag: "Ref", ref: REF }), "Use --remote=<ref> alone."],
    ] as const)(
      "suggests the --remote form when --project-ref meets %s",
      (_flag, overrides, hint) => {
        expect(failure({ ...overrides, projectRef: Option.some(REF) })).toMatchObject({
          suggestion: expect.stringContaining(hint),
        });
      },
    );

    it("suggests --remote=<ref> when --project-id meets --project-ref", () => {
      expect(failure({ projectRef: Option.some(REF), projectId: Option.some(REF) })).toMatchObject({
        message: "--project-id is a deprecated alias of --project-ref; pass only one of them.",
        suggestion: "Use --remote=<ref> instead.",
      });
    });

    it("suggests the --remote form for a selector conflict", () => {
      expect(failure({ ...remote({ _tag: "Linked" }), linked: true })).toMatchObject({
        suggestion: "Use --remote or --remote=<ref|branch|url> on its own.",
      });
    });

    it("lists only the selectors a command without a database connection has", () => {
      const result = parseTargetSelector({
        remote: Option.some({ _tag: "Linked" }),
        local: true,
        linked: false,
        projectRef: Option.none(),
      });
      expect(result).toMatchObject({
        failure: {
          _tag: "TargetSelectorConflictError",
          message:
            "Only one of --remote, --linked and --local can be set; got --remote and --local.",
          suggestion: "Use --remote or --remote=<ref|branch> on its own.",
        },
      });
    });

    it("suggests the parent-scoped hint when the command passes one", () => {
      expect(
        failure({ ...remote({ _tag: "Linked" }), linked: true }, { valueHint: "<ref>" }),
      ).toMatchObject({ suggestion: "Use --remote or --remote=<ref> on its own." });
    });

    it("rejects --project-id with --project-ref", () => {
      expect(failure({ projectRef: Option.some(REF), projectId: Option.some(REF) })).toMatchObject({
        _tag: "TargetSelectorConflictError",
        flags: ["--project-id", "--project-ref"],
      });
    });

    it("reports the selector conflict before the --project-ref conflict", () => {
      expect(failure({ local: true, linked: true, projectRef: Option.some(REF) })).toMatchObject({
        _tag: "TargetSelectorConflictError",
      });
    });
  });

  describe("empty values", () => {
    it.each([
      ["--db-url", { dbUrl: Option.some("") }, "Pass a connection string as --remote=<db-url>."],
      [
        "--project-ref",
        { projectRef: Option.some("") },
        "Pass a project ref, for example --remote=abcdefghijklmnopqrst",
      ],
      [
        "--project-id",
        { projectId: Option.some("") },
        "Pass a project ref, for example --remote=abcdefghijklmnopqrst",
      ],
    ] as const)("rejects an empty %s", (flag, overrides, suggestion) => {
      expect(failure(overrides)).toMatchObject({
        _tag: "TargetEmptyValueError",
        flag,
        message: `${flag} cannot be empty.`,
        suggestion,
      });
    });

    it("reports an empty value before any conflict", () => {
      expect(failure({ local: true, dbUrl: Option.some("") })).toMatchObject({
        _tag: "TargetEmptyValueError",
        flag: "--db-url",
      });
    });
  });

  describe("a command with no database connection", () => {
    const hosted = (overrides: Partial<TargetSelectorInput>, options?: TargetSelectorOptions) =>
      parseTargetSelector(
        {
          remote: Option.none(),
          local: false,
          linked: false,
          projectRef: Option.none(),
          ...overrides,
        },
        options,
      );

    it("accepts a project ref and a branch", () => {
      expect(hosted(remote({ _tag: "Ref", ref: REF }))).toEqual(
        Result.succeed({
          selection: { _tag: "Ref", ref: REF },
          deprecations: [],
        }),
      );
      expect(hosted(remote({ _tag: "Branch", name: "feature-x" }))).toMatchObject({
        success: { selection: { _tag: "Branch", name: "feature-x" } },
      });
    });

    it("rejects a database URL and names the command", () => {
      const result = hosted(remote({ _tag: "DbUrl", url: URL }), {
        commandName: "`supabase functions deploy`",
      });
      expect(result).toMatchObject({
        failure: {
          _tag: "TargetNeedsProjectError",
          message: "`supabase functions deploy` needs a project, not a database URL.",
        },
      });
    });

    it("falls back to a generic name for the command", () => {
      expect(hosted(remote({ _tag: "DbUrl", url: URL }))).toMatchObject({
        failure: { message: "This command needs a project, not a database URL." },
      });
    });
  });
});

describe("hasExplicitSelector", () => {
  it("is false when no selector flag is given", () => {
    expect(hasExplicitSelector(none)).toBe(false);
  });

  it.each<readonly [string, Partial<TargetSelectorInput>]>([
    ["--remote", { remote: Option.some({ _tag: "Linked" }) }],
    ["--linked", { linked: true }],
    ["--local", { local: true }],
    ["--db-url", { dbUrl: Option.some(URL) }],
    ["--project-ref", { projectRef: Option.some(REF) }],
    ["--project-id", { projectId: Option.some(REF) }],
  ])("is true for %s", (_flag, overrides) => {
    expect(hasExplicitSelector({ ...none, ...overrides })).toBe(true);
  });

  it("ignores a database URL flag a command does not declare", () => {
    const { dbUrl: _dbUrl, ...withoutDbUrl } = none;
    expect(hasExplicitSelector(withoutDbUrl)).toBe(false);
  });
});
