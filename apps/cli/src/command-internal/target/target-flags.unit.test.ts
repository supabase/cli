import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted } from "effect";
import { CliError, CliOutput, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { formatInvalidValueMessage } from "../../shared/cli/invalid-value-message.ts";
import { unwrapParam } from "../param-introspection.ts";
import {
  deprecatedProjectIdFlag,
  flagsForTarget,
  isRemoteFlag,
  projectTargetFlags,
  seedTargetGlobalFlags,
  targetFlags,
} from "./target-flags.ts";

const silentFormatter: CliOutput.Formatter = {
  formatCliError: () => "",
  formatError: () => "",
  formatErrors: () => "",
  formatHelpDoc: () => "",
  formatVersion: () => "",
};

const parseWith = <Config extends CliCommand.Command.Config>(
  config: Config,
  args: ReadonlyArray<string>,
) => {
  const parsed: Array<unknown> = [];
  const command = Command.make("target-test", config).pipe(
    Command.withHandler((flags) => Effect.sync(() => parsed.push(flags))),
  );
  return Command.runWith(command, { version: "0.0.0-test" })(args).pipe(
    Effect.provide(Layer.mergeAll(BunServices.layer, CliOutput.layer(silentFormatter))),
    Effect.map(() => parsed[0]),
  );
};

const rejectedMessage = <Config extends CliCommand.Command.Config>(
  config: Config,
  args: ReadonlyArray<string>,
) =>
  parseWith(config, args).pipe(
    Effect.flip,
    Effect.map((error) => {
      if (!CliError.isCliError(error) || error._tag !== "ShowHelp") {
        throw new Error(`expected a parse failure, got ${String(error)}`);
      }
      const [inner] = error.errors;
      if (inner?._tag !== "InvalidValue") {
        throw new Error(`expected an invalid value, got ${inner?._tag}`);
      }
      return formatInvalidValueMessage(inner) ?? inner.message;
    }),
  );

const describeFlag = (flag: Flag.Flag<unknown>) => {
  const single = unwrapParam(flag)?.single;
  return {
    name: single?.name,
    hidden: single?.hidden,
    description: Option.getOrUndefined(single?.description ?? Option.none()),
  };
};

const REF = "abcdefghijklmnopqrst";
const URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

describe("targetFlags", () => {
  const withDbUrl = targetFlags({ subject: "database", dbUrl: true });

  it.effect("defaults every selector to absent", () =>
    Effect.gen(function* () {
      expect(yield* parseWith(withDbUrl, [])).toEqual({
        remote: Option.none(),
        local: false,
        linked: false,
        dbUrl: Option.none(),
        projectRef: Option.none(),
      });
    }),
  );

  it.effect.each([
    { args: ["--remote"], expected: { _tag: "Linked" } },
    { args: ["--remote", "yes"], expected: { _tag: "Linked" } },
    { args: ["--remote", "y"], expected: { _tag: "Linked" } },
    { args: ["--remote=on"], expected: { _tag: "Linked" } },
    { args: ["--remote=1"], expected: { _tag: "Linked" } },
    { args: [`--remote=${REF}`], expected: { _tag: "Ref", ref: REF } },
    { args: [`--remote=${URL}`], expected: { _tag: "DbUrl", url: URL } },
    { args: ["--remote=feature-x"], expected: { _tag: "Branch", name: "feature-x" } },
    { args: ["--remote=Feature_X"], expected: { _tag: "Branch", name: "Feature_X" } },
  ])("parses $args as $expected", ({ args, expected }) =>
    Effect.gen(function* () {
      expect(yield* parseWith(withDbUrl, args)).toMatchObject({ remote: Option.some(expected) });
    }),
  );

  it.effect("keeps the deprecated aliases parseable", () =>
    Effect.gen(function* () {
      expect(yield* parseWith(withDbUrl, ["--local"])).toMatchObject({ local: true });
      expect(yield* parseWith(withDbUrl, ["--linked"])).toMatchObject({ linked: true });
      expect(
        yield* parseWith(withDbUrl, ["--db-url", "postgresql://h/db", "--project-ref", "abc"]),
      ).toMatchObject({
        dbUrl: Option.some("postgresql://h/db"),
        projectRef: Option.some("abc"),
      });
      expect(yield* parseWith(withDbUrl, ["--linked=false"])).toMatchObject({ linked: false });
    }),
  );

  it.effect.each([
    { args: ["--remote=false"] },
    { args: ["--remote=0"] },
    { args: ["--remote", "off"] },
    { args: ["--no-remote"] },
  ])("rejects $args by pointing at the local default", ({ args }) =>
    Effect.gen(function* () {
      expect(yield* rejectedMessage(withDbUrl, args)).toBe(
        "--remote doesn't take false. Leave it out to target the local database.",
      );
    }),
  );

  it.effect.each([{ args: ["--remote", "n"] }, { args: ["--remote=n"] }])(
    "rejects $args as the off switch, not a branch named n",
    ({ args }) =>
      Effect.gen(function* () {
        expect(yield* rejectedMessage(withDbUrl, args)).toBe(
          "--remote doesn't take false. Leave it out to target the local database.",
        );
      }),
  );

  it.effect("rejects an empty value and offers every form the command takes", () =>
    Effect.gen(function* () {
      expect(yield* rejectedMessage(withDbUrl, ["--remote="])).toBe(
        "--remote= has an empty value. Pass --remote for the linked project or --remote=<ref|branch|url>; leave it out to target the local database.",
      );
    }),
  );

  it.effect("names the Storage API in its local-default messages", () =>
    Effect.gen(function* () {
      const storage = targetFlags({ subject: "Storage API", dbUrl: false });
      expect(yield* rejectedMessage(storage, ["--no-remote"])).toBe(
        "--remote doesn't take false. Leave it out to target the local Storage API.",
      );
      expect(yield* rejectedMessage(storage, ["--remote="])).toBe(
        "--remote= has an empty value. Pass --remote for the linked project or --remote=<ref|branch>; leave it out to target the local Storage API.",
      );
    }),
  );

  it.effect.each([
    {
      value: `https://${REF}.supabase.co`,
      message: `--remote takes a postgres:// URL, a project ref or a branch name; to target that project, use --remote=${REF}.`,
    },
    {
      value: "https://example.com/db",
      message: "--remote takes a postgres:// URL, a project ref or a branch name.",
    },
  ])(
    "rejects $value because a URL that is not postgres:// never names a branch",
    ({ value, message }) =>
      Effect.gen(function* () {
        expect(yield* rejectedMessage(withDbUrl, [`--remote=${value}`])).toBe(message);
      }),
  );

  it.effect("rejects a keyword connection string without echoing it", () =>
    Effect.gen(function* () {
      const message = yield* rejectedMessage(withDbUrl, [
        "--remote=host=db.example.com user=postgres password=hunter2",
      ]);
      expect(message).toBe(
        "--remote takes a postgres:// URL, a project ref or a branch name; convert a connection string to a postgresql:// URL and pass --remote=<url>.",
      );
      const storage = targetFlags({ subject: "Storage API", dbUrl: false });
      expect(yield* rejectedMessage(storage, ["--remote=host=db.example.com"])).toBe(
        "--remote takes a project ref or a branch name.",
      );
    }),
  );

  it.effect(
    "leaves the postgres:// URL out of the foreign-URL message where none is accepted",
    () =>
      Effect.gen(function* () {
        const storage = targetFlags({ subject: "Storage API", dbUrl: false });
        expect(yield* rejectedMessage(storage, ["--remote=https://example.com"])).toBe(
          "--remote takes a project ref or a branch name.",
        );
      }),
  );

  it("omits --db-url for commands without a database connection", () => {
    const storage = targetFlags({ subject: "Storage API", dbUrl: false });
    expect(Object.keys(storage).sort()).toEqual(["linked", "local", "projectRef", "remote"]);
    expect(Object.keys(withDbUrl).sort()).toEqual([
      "dbUrl",
      "linked",
      "local",
      "projectRef",
      "remote",
    ]);
  });

  it.effect.each([
    {
      name: "a command with no database connection",
      config: targetFlags({ subject: "Storage API", dbUrl: false }),
      message: "--remote takes a project ref or a branch name.",
    },
    {
      name: "a hosted command",
      config: projectTargetFlags(),
      message: "--remote takes a project ref or a branch name.",
    },
    {
      name: "a parent-scoped hosted command",
      config: projectTargetFlags({ parent: true }),
      message: "--remote takes a project ref.",
    },
    {
      name: "the seed group",
      config: { remote: seedTargetGlobalFlags.remote.flag },
      message: "--remote takes a project ref or a branch name.",
    },
  ])("rejects a database URL on $name without echoing it", ({ config, message }) =>
    Effect.gen(function* () {
      expect(yield* rejectedMessage(config, [`--remote=${URL}`])).toBe(message);
    }),
  );

  it("shows --remote and hides every deprecated alias", () => {
    expect(describeFlag(withDbUrl.remote).hidden).toBeFalsy();
    for (const alias of [
      withDbUrl.local,
      withDbUrl.linked,
      withDbUrl.dbUrl,
      withDbUrl.projectRef,
    ]) {
      expect(describeFlag(alias).hidden).toBe(true);
    }
  });

  it("describes --remote by what the command can target", () => {
    expect(describeFlag(withDbUrl.remote).description).toBe(
      "Target a remote database: the linked project, or --remote=<ref|branch|url>.",
    );
    expect(
      describeFlag(targetFlags({ subject: "Storage API", dbUrl: false }).remote).description,
    ).toBe("Target a remote Storage API: the linked project, or --remote=<ref|branch>.");
  });
});

describe("projectTargetFlags", () => {
  const hosted = projectTargetFlags();

  it.effect("parses --remote and the deprecated --project-ref", () =>
    Effect.gen(function* () {
      expect(yield* parseWith(hosted, [])).toEqual({
        remote: Option.none(),
        projectRef: Option.none(),
      });
      expect(yield* parseWith(hosted, [`--remote=${REF}`])).toMatchObject({
        remote: Option.some({ _tag: "Ref", ref: REF }),
      });
      expect(yield* parseWith(hosted, ["--project-ref", REF])).toMatchObject({
        projectRef: Option.some(REF),
      });
    }),
  );

  it.effect("rejects an off value and an empty value by pointing at the linked project", () =>
    Effect.gen(function* () {
      expect(yield* rejectedMessage(hosted, ["--no-remote"])).toBe(
        "--remote doesn't take false. Leave it out to use the linked project.",
      );
      expect(yield* rejectedMessage(hosted, ["--remote="])).toBe(
        "--remote= has an empty value. Pass --remote for the linked project or --remote=<ref|branch>; leave it out to use the linked project.",
      );
    }),
  );

  it.effect("takes only a project ref on a parent-scoped command", () =>
    Effect.gen(function* () {
      const parent = projectTargetFlags({ parent: true });
      expect(yield* rejectedMessage(parent, ["--remote="])).toBe(
        "--remote= has an empty value. Pass --remote for the linked project or --remote=<ref>; leave it out to use the linked project.",
      );
      expect(yield* rejectedMessage(parent, ["--remote=https://example.com"])).toBe(
        "--remote takes a project ref.",
      );
      expect(describeFlag(parent.remote).description).toBe(
        "Target another project: --remote=<ref>. Defaults to the linked project.",
      );
    }),
  );

  it("describes --remote as another project and hides --project-ref", () => {
    expect(describeFlag(hosted.remote).description).toBe(
      "Target another project: --remote=<ref|branch>. Defaults to the linked project.",
    );
    expect(describeFlag(hosted.projectRef).hidden).toBe(true);
  });
});

describe("deprecatedProjectIdFlag", () => {
  it("is hidden from help", () => {
    expect(unwrapParam(deprecatedProjectIdFlag)?.single.hidden).toBe(true);
  });

  it.effect("parses an optional value", () =>
    Effect.gen(function* () {
      expect(yield* parseWith({ projectId: deprecatedProjectIdFlag }, [])).toEqual({
        projectId: Option.none(),
      });
      expect(
        yield* parseWith({ projectId: deprecatedProjectIdFlag }, ["--project-id", "abc"]),
      ).toEqual({ projectId: Option.some("abc") });
    }),
  );
});

describe("isRemoteFlag", () => {
  const singleOf = (flag: Flag.Flag<unknown>) => {
    const single = unwrapParam(flag)?.single;
    if (single === undefined) throw new Error("expected a single flag");
    return single;
  };

  it("recognises every declaration of --remote by its primitive, not its name", () => {
    expect(isRemoteFlag(singleOf(targetFlags({ subject: "database", dbUrl: true }).remote))).toBe(
      true,
    );
    expect(isRemoteFlag(singleOf(projectTargetFlags().remote))).toBe(true);
    expect(isRemoteFlag(singleOf(seedTargetGlobalFlags.remote.flag))).toBe(true);
  });

  it("does not take a boolean flag for --remote", () => {
    expect(isRemoteFlag(singleOf(targetFlags({ subject: "database", dbUrl: true }).linked))).toBe(
      false,
    );
    expect(isRemoteFlag(singleOf(Flag.Boolean("remote")))).toBe(false);
  });
});

describe("seedTargetGlobalFlags", () => {
  it("takes a ref or a branch, never a database URL", () => {
    expect(describeFlag(seedTargetGlobalFlags.remote.flag).description).toBe(
      "Target a remote Storage API: the linked project, or --remote=<ref|branch>.",
    );
  });

  it("shares the selector flag names with targetFlags", () => {
    expect(describeFlag(seedTargetGlobalFlags.remote.flag).name).toBe("remote");
    expect(describeFlag(seedTargetGlobalFlags.linked.flag).name).toBe("linked");
    expect(describeFlag(seedTargetGlobalFlags.local.flag).name).toBe("local");
  });
});

describe("flagsForTarget", () => {
  it("names the flags that re-select each kind of target without echoing a db-url", () => {
    expect(flagsForTarget({ kind: "local" })).toBe("");
    expect(flagsForTarget({ kind: "db-url", url: Redacted.make("postgresql://u:pw@h/db") })).toBe(
      "--remote=<db-url>",
    );
    expect(
      flagsForTarget({ kind: "linked", ref: REF, source: "file", matchesLinkedRef: true }),
    ).toBe("--remote");
  });

  it("keeps an explicit ref that is not the linked project", () => {
    expect(
      flagsForTarget({ kind: "linked", ref: REF, source: "flag", matchesLinkedRef: false }),
    ).toBe(`--remote=${REF}`);
  });
});
