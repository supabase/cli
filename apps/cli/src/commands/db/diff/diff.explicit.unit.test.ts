import { describe, expect, it } from "vitest";

import type { TargetDeprecation } from "../../../command-internal/target/target-selector.ts";
import { classifyExplicitRef, explicitDeprecationMessages } from "./diff.explicit.ts";

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
