import { describe, expect, it } from "vitest";

import {
  deprecationMessages,
  rebuildCommand,
  refFromDbUrl,
  remoteFlagText,
} from "./target-deprecation.ts";
import type { TargetDeprecation } from "./target-selector.ts";

const REF = "abcdefghijklmnopqrst";
const HOST = "supabase.co";

describe("remoteFlagText", () => {
  it.each([
    { remote: { _tag: "Linked" }, expected: "--remote" },
    { remote: { _tag: "Ref", ref: REF }, expected: `--remote=${REF}` },
    { remote: { _tag: "Branch", name: "feature-x" }, expected: "--remote=feature-x" },
    { remote: { _tag: "Branch", name: "my branch" }, expected: "--remote='my branch'" },
    { remote: { _tag: "DbUrl", url: "postgresql://u:pw@h/db" }, expected: "--remote=<db-url>" },
  ] as const)("spells $remote as $expected", ({ remote, expected }) => {
    expect(remoteFlagText(remote)).toBe(expected);
  });
});

describe("rebuildCommand", () => {
  it.each([
    {
      name: "drops a deprecated switch and puts --remote last",
      argv: ["db", "push", "--linked", "--dry-run"],
      remote: "--remote",
      expected: "supabase db push --dry-run --remote",
    },
    {
      name: "drops a deprecated value flag together with its value",
      argv: ["db", "dump", "--project-ref", REF, "-f", "out.sql"],
      remote: `--remote=${REF}`,
      expected: `supabase db dump -f out.sql --remote=${REF}`,
    },
    {
      name: "drops an inline deprecated value",
      argv: ["db", "dump", `--project-ref=${REF}`],
      remote: `--remote=${REF}`,
      expected: `supabase db dump --remote=${REF}`,
    },
    {
      name: "drops a boolean literal that follows a deprecated switch",
      argv: ["db", "push", "--linked", "true"],
      remote: "--remote",
      expected: "supabase db push --remote",
    },
    {
      name: "replaces a --remote the alias already maps to",
      argv: ["db", "push", "--remote", "--project-ref", REF],
      remote: `--remote=${REF}`,
      expected: `supabase db push --remote=${REF}`,
    },
    {
      name: "keeps --remote ahead of a literal --",
      argv: ["functions", "deploy", "--linked", "--", "-weird"],
      remote: "--remote",
      expected: "supabase functions deploy --remote -- -weird",
    },
    {
      name: "redacts a database URL and a password",
      argv: ["db", "push", "--db-url", "postgresql://u:pw@h/db", "--password", "hunter2"],
      remote: "--remote=<db-url>",
      expected: "supabase db push --password <redacted> --remote=<db-url>",
    },
    {
      name: "redacts an inline password and a stray URL operand",
      argv: ["db", "push", "--password=hunter2", "postgresql://u:pw@h/db", "--local"],
      remote: undefined,
      expected: "supabase db push --password=<redacted> <db-url>",
    },
    {
      name: "quotes a token the shell would split",
      argv: ["storage", "ls", "ss:///my bucket", "--linked"],
      remote: "--remote",
      expected: "supabase storage ls 'ss:///my bucket' --remote",
    },
  ])("$name", ({ argv, remote, expected }) => {
    expect(rebuildCommand(argv, remote)).toBe(expected);
  });
});

describe("refFromDbUrl", () => {
  it.each([
    { url: `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`, expected: REF },
    {
      url: `postgresql://postgres.${REF}:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`,
      expected: REF,
    },
    { url: "postgresql://postgres:pw@db.example.com:5432/postgres", expected: undefined },
    { url: "postgresql://postgres:pw@127.0.0.1:54322/postgres", expected: undefined },
    { url: "not a url", expected: undefined },
  ])("reads $expected from $url", ({ url, expected }) => {
    expect(refFromDbUrl(url, HOST)).toBe(expected);
  });
});

describe("deprecationMessages", () => {
  const messages = (
    deprecations: ReadonlyArray<TargetDeprecation>,
    argv: ReadonlyArray<string> | undefined,
  ) => deprecationMessages(deprecations, { argv, projectHost: HOST });

  it("names the flag, the replacement and v4, with the command as the user ran it", () => {
    expect(
      messages(
        [{ kind: "remote-alias", flags: ["--linked"], remote: { _tag: "Linked" } }],
        ["db", "push", "--linked"],
      ),
    ).toEqual([
      "--linked is deprecated and will be removed in v4. Use --remote instead: supabase db push --remote",
    ]);
  });

  it("joins every alias the run used into one warning", () => {
    expect(
      messages(
        [
          {
            kind: "remote-alias",
            flags: ["--linked", "--project-ref"],
            remote: { _tag: "Ref", ref: REF },
          },
        ],
        ["db", "push", "--linked", "--project-ref", REF],
      ),
    ).toEqual([
      `--linked and --project-ref are deprecated and will be removed in v4. Use --remote instead: supabase db push --remote=${REF}`,
    ]);
  });

  it("offers the project ref a Supabase database URL already names, without echoing the URL", () => {
    const url = `postgresql://postgres:hunter2@db.${REF}.supabase.co:5432/postgres`;
    const [message] = messages(
      [{ kind: "remote-alias", flags: ["--db-url"], remote: { _tag: "DbUrl", url } }],
      ["db", "push", "--db-url", url],
    );
    expect(message).toBe(
      `--db-url is deprecated and will be removed in v4. Use --remote instead: supabase db push --remote=<db-url>, or --remote=${REF} with an access token set`,
    );
    expect(message).not.toContain("hunter2");
  });

  it("omits the command line when the argv is unknown", () => {
    expect(
      messages(
        [{ kind: "remote-alias", flags: ["--project-id"], remote: { _tag: "Ref", ref: REF } }],
        undefined,
      ),
    ).toEqual(["--project-id is deprecated and will be removed in v4. Use --remote instead"]);
  });

  it("says --local is not needed and drops it from the example", () => {
    expect(messages([{ kind: "local" }], ["db", "push", "--local"])).toEqual([
      "--local isn't needed (local is the default) and will be removed in v4: supabase db push",
    ]);
  });
});
