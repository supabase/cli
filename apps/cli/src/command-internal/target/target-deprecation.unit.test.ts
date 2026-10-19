import { describe, expect, it } from "vitest";

import {
  type DeprecationCommand,
  deprecationMessages,
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
    { remote: { _tag: "Branch", name: "u:pw@staging" }, expected: "--remote=staging" },
    { remote: { _tag: "Branch", name: "TRUE" }, expected: "--remote=<its ref or UUID>" },
    { remote: { _tag: "DbUrl", url: "postgresql://u:pw@h/db" }, expected: "--remote=<db-url>" },
  ] as const)("spells $remote as $expected", ({ remote, expected }) => {
    expect(remoteFlagText(remote)).toBe(expected);
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
  const dbPush: DeprecationCommand = { path: "db push", operands: [] };
  const secretsSet: DeprecationCommand = { path: "secrets set", operands: ["<NAME=VALUE>..."] };

  const messages = (
    deprecations: ReadonlyArray<TargetDeprecation>,
    command: DeprecationCommand | undefined = dbPush,
  ) => deprecationMessages(deprecations, { command, projectHost: HOST });

  it("shows the command path, its operand placeholders and the replacement last", () => {
    expect(
      messages(
        [{ kind: "remote-alias", flags: ["--project-ref"], remote: { _tag: "Ref", ref: REF } }],
        secretsSet,
      ),
    ).toEqual([
      `--project-ref is deprecated and will be removed in v4. Use --remote=<ref> instead: supabase secrets set <NAME=VALUE>... --remote=${REF}`,
    ]);
  });

  it("points a deprecated --linked at a bare --remote", () => {
    expect(
      messages([{ kind: "remote-alias", flags: ["--linked"], remote: { _tag: "Linked" } }]),
    ).toEqual([
      "--linked is deprecated and will be removed in v4. Use --remote instead: supabase db push --remote",
    ]);
  });

  it("joins every alias the run used into one warning", () => {
    expect(
      messages([
        {
          kind: "remote-alias",
          flags: ["--linked", "--project-ref"],
          remote: { _tag: "Ref", ref: REF },
        },
      ]),
    ).toEqual([
      `--linked and --project-ref are deprecated and will be removed in v4. Use --remote=<ref> instead: supabase db push --remote=${REF}`,
    ]);
  });

  it("shows the branch an alias value names, without its userinfo", () => {
    expect(
      messages([
        {
          kind: "remote-alias",
          flags: ["--project-ref"],
          remote: { _tag: "Branch", name: "staging" },
        },
      ]),
    ).toEqual([
      "--project-ref is deprecated and will be removed in v4. Use --remote=<branch> instead: supabase db push --remote=staging",
    ]);
  });

  it("offers the project ref a Supabase database URL already names, without echoing the URL", () => {
    const url = `postgresql://postgres:hunter2@db.${REF}.supabase.co:5432/postgres`;
    const [message] = messages([
      { kind: "remote-alias", flags: ["--db-url"], remote: { _tag: "DbUrl", url } },
    ]);
    expect(message).toBe(
      `--db-url is deprecated and will be removed in v4. Use --remote=<db-url> instead: supabase db push --remote=<db-url>, or --remote=${REF} with an access token set`,
    );
    expect(message).not.toContain("hunter2");
  });

  it("asks for a postgresql:// URL when --db-url held a keyword connection string", () => {
    const [message] = messages([
      {
        kind: "remote-alias",
        flags: ["--db-url"],
        remote: { _tag: "DbUrl", url: "host=db.example.com user=postgres password=hunter2" },
      },
    ]);
    expect(message).toBe(
      "--db-url is deprecated and will be removed in v4. Convert the connection string to a postgresql:// URL and pass it as --remote=<url> instead: supabase db push --remote=<url>",
    );
    expect(message).not.toContain("hunter2");
  });

  it.each(["true", "No", "OFF", "1"])(
    "says a branch named %s is reached by its ref or UUID",
    (name) => {
      expect(
        messages([
          { kind: "remote-alias", flags: ["--project-ref"], remote: { _tag: "Branch", name } },
        ]),
      ).toEqual([
        `--project-ref is deprecated and will be removed in v4. Reach a branch named "${name}" with --remote=<its ref or UUID> instead: supabase db push --remote=<its ref or UUID>`,
      ]);
    },
  );

  it("drops the example when the command is unknown", () => {
    expect(
      deprecationMessages(
        [{ kind: "remote-alias", flags: ["--project-id"], remote: { _tag: "Ref", ref: REF } }],
        { command: undefined, projectHost: HOST },
      ),
    ).toEqual(["--project-id is deprecated and will be removed in v4. Use --remote=<ref> instead"]);
  });

  it("says --local is not needed and shows the command without it", () => {
    expect(messages([{ kind: "local" }], secretsSet)).toEqual([
      "--local isn't needed (local is the default) and will be removed in v4: supabase secrets set <NAME=VALUE>...",
    ]);
  });
});
