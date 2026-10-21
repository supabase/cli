import { Option, Result } from "effect";
import { describe, expect, it } from "vitest";

import type { TargetFlagValues } from "../../../command-internal/target/target-flags.ts";
import {
  parseTargetSelector,
  type TargetDeprecation,
} from "../../../command-internal/target/target-selector.ts";
import { TargetSelectorConflictError } from "../../../command-internal/target/target.errors.ts";
import {
  classifyExplicitRef,
  explicitDeprecationMessages,
  explicitSelectorError,
  unresolvedBranchSuggestion,
} from "./diff.explicit.ts";

const REF = "abcdefghijklmnopqrst";
const UUID = "11111111-2222-4333-8444-555555555555";

describe("classifyExplicitRef", () => {
  it.each([
    { value: "local", expected: { _tag: "Local" } },
    { value: "migrations", expected: { _tag: "Migrations" } },
    { value: "remote", expected: { _tag: "Remote", viaDeprecatedLinked: false } },
    { value: "linked", expected: { _tag: "Remote", viaDeprecatedLinked: true } },
  ])("reads the keyword $value", ({ value, expected }) => {
    expect(classifyExplicitRef(value)).toEqual(expected);
  });

  it.each([
    { value: REF, expected: { _tag: "Ref", ref: REF } },
    {
      value: "postgres://u:p@h:5432/db",
      expected: { _tag: "DbUrl", url: "postgres://u:p@h:5432/db" },
    },
    { value: "postgresql://u@h/db", expected: { _tag: "DbUrl", url: "postgresql://u@h/db" } },
    { value: "feature-x", expected: { _tag: "Branch", name: "feature-x" } },
    { value: UUID, expected: { _tag: "Branch", name: UUID } },
  ])("classifies $value like a --remote value", ({ value, expected }) => {
    expect(classifyExplicitRef(value)).toEqual(expected);
  });

  it.each([
    { value: "https://u:p@db.example.com/x", expected: { _tag: "ForeignUrl", ref: undefined } },
    {
      value: `https://${REF}.supabase.co`,
      expected: { _tag: "ForeignUrl", ref: REF },
    },
  ])("keeps the non-postgres URL $value apart from a branch name", ({ value, expected }) => {
    expect(classifyExplicitRef(value)).toEqual(expected);
  });

  it.each(["host=h password=x", "dbname=postgres", "password=x"])(
    "keeps the keyword connection string %s apart from a branch name",
    (value) => {
      expect(classifyExplicitRef(value)).toEqual({ _tag: "KeywordDsn" });
    },
  );

  it("reaches a branch named like a keyword through its UUID, not the keyword", () => {
    expect(classifyExplicitRef("Remote")).toEqual({ _tag: "Branch", name: "Remote" });
    expect(classifyExplicitRef(UUID)).toEqual({ _tag: "Branch", name: UUID });
  });
});

describe("explicitDeprecationMessages", () => {
  const messages = (deprecations: ReadonlyArray<TargetDeprecation>) =>
    explicitDeprecationMessages(deprecations);

  it.each([
    {
      flags: ["--linked"],
      remote: { _tag: "Linked" },
      expected:
        "--linked is deprecated and will be removed in v4. Use --from=remote or --to=remote instead",
    },
    {
      flags: ["--project-ref"],
      remote: { _tag: "Ref", ref: REF },
      expected:
        "--project-ref is deprecated and will be removed in v4. Use --from=<ref> or --to=<ref> instead",
    },
    {
      flags: ["--project-ref"],
      remote: { _tag: "Branch", name: "staging" },
      expected:
        "--project-ref is deprecated and will be removed in v4. Use --from=<branch> or --to=<branch> instead",
    },
    {
      flags: ["--project-ref"],
      remote: { _tag: "Branch", name: "true" },
      expected:
        "--project-ref is deprecated and will be removed in v4. Use --from=<branch> or --to=<branch> instead",
    },
    {
      flags: ["--linked", "--project-ref"],
      remote: { _tag: "Ref", ref: REF },
      expected:
        "--linked and --project-ref are deprecated and will be removed in v4. Use --from=<ref> or --to=<ref> instead",
    },
  ] as const)("points $flags at $expected", ({ flags, remote, expected }) => {
    expect(messages([{ kind: "remote-alias", flags, remote }])).toEqual([expected]);
  });

  it.each(["local", "migrations", "remote", "linked"])(
    "says a branch named %s is reached by its ref or UUID, since the keyword wins",
    (name) => {
      expect(
        messages([
          { kind: "remote-alias", flags: ["--project-ref"], remote: { _tag: "Branch", name } },
        ]),
      ).toEqual([
        `--project-ref is deprecated and will be removed in v4. Reach a branch named "${name}" with --from=<its ref or UUID> or --to=<its ref or UUID> instead`,
      ]);
    },
  );

  it("points --db-url at --from=<url> without echoing the URL", () => {
    const url = "postgresql://postgres:hunter2@db.example.com:5432/postgres";
    const [message] = messages([
      { kind: "remote-alias", flags: ["--db-url"], remote: { _tag: "DbUrl", url } },
    ]);
    expect(message).toBe(
      "--db-url is deprecated and will be removed in v4. Use --from=<url> or --to=<url> instead",
    );
    expect(message).not.toContain("hunter2");
  });

  it("asks for a postgresql:// URL when --db-url held a keyword connection string", () => {
    const [message] = messages([
      {
        kind: "remote-alias",
        flags: ["--db-url"],
        remote: { _tag: "DbUrl", url: "host=db.example.com password=hunter2" },
      },
    ]);
    expect(message).toBe(
      "--db-url is deprecated and will be removed in v4. Convert the connection string to a postgresql:// URL and pass it as --from=<url> or --to=<url> instead",
    );
    expect(message).not.toContain("hunter2");
  });

  it("says --local is not needed", () => {
    expect(messages([{ kind: "local" }])).toEqual([
      "--local isn't needed (local is the default) and will be removed in v4",
    ]);
  });
});

describe("explicitSelectorError", () => {
  const none: TargetFlagValues = {
    remote: Option.none(),
    local: false,
    linked: false,
    dbUrl: Option.none(),
    projectRef: Option.none(),
  };

  const selectorFailure = (overrides: Partial<TargetFlagValues>) => {
    const result = parseTargetSelector({ ...none, ...overrides });
    if (Result.isSuccess(result)) throw new Error("expected the selector to be rejected");
    return result.failure;
  };

  it.each([
    {
      label: "an empty --project-ref",
      overrides: { projectRef: Option.some("") },
      expected: {
        _tag: "TargetEmptyValueError",
        flag: "--project-ref",
        message: "--project-ref cannot be empty.",
        suggestion: "Pass a project ref as --from=<ref> or --to=<ref>.",
      },
    },
    {
      label: "an empty --db-url",
      overrides: { dbUrl: Option.some("") },
      expected: {
        _tag: "TargetEmptyValueError",
        flag: "--db-url",
        message: "--db-url cannot be empty.",
        suggestion: "Pass a postgresql:// URL as --from=<url> or --to=<url>.",
      },
    },
    {
      label: "a --project-ref URL naming a project",
      overrides: { projectRef: Option.some(`https://${REF}.supabase.co`) },
      expected: {
        _tag: "TargetInvalidValueError",
        flag: "--project-ref",
        message: "--project-ref takes a project ref or a branch name, not a URL.",
        suggestion: `Use --from=${REF} or --to=${REF}.`,
        ref: REF,
      },
    },
    {
      label: "a --project-ref URL naming no project",
      overrides: { projectRef: Option.some("https://db.example.com/x") },
      expected: {
        _tag: "TargetInvalidValueError",
        flag: "--project-ref",
        message: "--project-ref takes a project ref or a branch name, not a URL.",
        suggestion: "Pass a project ref as --from=<ref> or --to=<ref>.",
      },
    },
    {
      label: "--project-ref with --local",
      overrides: { projectRef: Option.some(REF), local: true },
      expected: {
        _tag: "TargetProjectRefConflictError",
        conflictsWith: "--local",
        message: "--project-ref selects a remote project and cannot be combined with --local.",
        suggestion: "Use --from=<ref> or --to=<ref> instead of --project-ref, and drop --local.",
      },
    },
    {
      label: "--project-ref with --db-url",
      overrides: { projectRef: Option.some(REF), dbUrl: Option.some("postgresql://u@h/db") },
      expected: {
        _tag: "TargetProjectRefConflictError",
        conflictsWith: "--db-url",
        message: "--project-ref selects a remote project and cannot be combined with --db-url.",
        suggestion:
          "Use --from=<ref> or --to=<ref> instead of --project-ref, and --from=<url> or --to=<url> instead of --db-url.",
      },
    },
    {
      label: "--linked with --local",
      overrides: { linked: true, local: true },
      expected: {
        _tag: "TargetSelectorConflictError",
        flags: ["--linked", "--local"],
        message: "Only one of --linked, --db-url and --local can be set; got --linked and --local.",
        suggestion: "Use --from=remote or --to=remote instead of --linked, and drop --local.",
      },
    },
    {
      label: "--linked with --db-url",
      overrides: { linked: true, dbUrl: Option.some("postgresql://u@h/db") },
      expected: {
        _tag: "TargetSelectorConflictError",
        flags: ["--linked", "--db-url"],
        message:
          "Only one of --linked, --db-url and --local can be set; got --linked and --db-url.",
        suggestion:
          "Use --from=remote or --to=remote instead of --linked, and --from=<url> or --to=<url> instead of --db-url.",
      },
    },
    {
      label: "--db-url with --local",
      overrides: { dbUrl: Option.some("postgresql://u@h/db"), local: true },
      expected: {
        _tag: "TargetSelectorConflictError",
        flags: ["--db-url", "--local"],
        message: "Only one of --linked, --db-url and --local can be set; got --db-url and --local.",
        suggestion: "Use --from=<url> or --to=<url> instead of --db-url, and drop --local.",
      },
    },
    {
      label: "--linked, --db-url and --local together",
      overrides: { linked: true, dbUrl: Option.some("postgresql://u@h/db"), local: true },
      expected: {
        _tag: "TargetSelectorConflictError",
        flags: ["--linked", "--db-url", "--local"],
        message:
          "Only one of --linked, --db-url and --local can be set; got --linked, --db-url and --local.",
        suggestion:
          "Use --from=remote or --to=remote instead of --linked, --from=<url> or --to=<url> instead of --db-url, and drop --local.",
      },
    },
  ])("points $label at --from/--to and keeps the rest of the error", ({ overrides, expected }) => {
    const rewritten = explicitSelectorError(selectorFailure(overrides));
    expect(rewritten).toMatchObject(expected);
    expect(rewritten.suggestion).not.toContain("--remote");
  });

  it.each([
    ["--project-id", "--project-ref"],
    ["--remote", "--local"],
    ["--linked", "--remote"],
  ])(
    "returns a conflict between %s and %s unchanged, since db diff cannot raise it",
    (...flags) => {
      const conflict = new TargetSelectorConflictError({
        flags,
        message: "m",
        suggestion: "s",
      });
      expect(explicitSelectorError(conflict)).toBe(conflict);
    },
  );

  it("never echoes the connection string a conflict was raised for", () => {
    const rewritten = explicitSelectorError(
      selectorFailure({
        projectRef: Option.some(REF),
        dbUrl: Option.some("postgresql://u:hunter2@db.example.com:5432/postgres"),
      }),
    );
    expect(`${rewritten.message} ${rewritten.suggestion}`).not.toContain("hunter2");
  });
});

describe("unresolvedBranchSuggestion", () => {
  const accepted = (flag: string) =>
    `${flag} accepts local, migrations, remote, a project ref, a branch of the linked project, or a postgresql:// URL.`;

  it.each([
    { flag: "--from", value: "lcoal", keyword: "local" },
    { flag: "--to", value: "migratoins", keyword: "migrations" },
    { flag: "--from", value: "remove", keyword: "remote" },
    { flag: "--to", value: "Locale", keyword: "local" },
  ] as const)("leads with $flag=$keyword for $value", ({ flag, value, keyword }) => {
    expect(unresolvedBranchSuggestion(flag, value)).toBe(
      `Did you mean ${flag}=${keyword}? ${accepted(flag)}`,
    );
  });

  it.each(["feature-x", "main", "staging", "lo"])(
    "only lists what the flag accepts for %s",
    (value) => {
      expect(unresolvedBranchSuggestion("--to", value)).toBe(accepted("--to"));
    },
  );
});
