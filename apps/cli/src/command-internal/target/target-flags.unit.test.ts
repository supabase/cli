import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { CliOutput, Command, type Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { unwrapParam } from "../param-introspection.ts";
import { deprecatedProjectIdFlag, seedTargetGlobalFlags, targetFlags } from "./target-flags.ts";

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

const describeFlag = (flag: Flag.Flag<unknown>) => {
  const single = unwrapParam(flag)?.single;
  return {
    name: single?.name,
    description: Option.getOrUndefined(single?.description ?? Option.none()),
  };
};

describe("targetFlags", () => {
  const withDbUrl = targetFlags({ group: "selectable", subject: "database", dbUrl: true });

  it.effect("defaults every selector to absent", () =>
    Effect.gen(function* () {
      expect(yield* parseWith(withDbUrl, [])).toEqual({
        local: false,
        linked: false,
        dbUrl: Option.none(),
        projectRef: Option.none(),
      });
    }),
  );

  it.effect("parses each selector", () =>
    Effect.gen(function* () {
      expect(yield* parseWith(withDbUrl, ["--local"])).toMatchObject({ local: true });
      expect(yield* parseWith(withDbUrl, ["--linked"])).toMatchObject({ linked: true });
      expect(
        yield* parseWith(withDbUrl, ["--db-url", "postgresql://h/db", "--project-ref", "abc"]),
      ).toMatchObject({
        dbUrl: Option.some("postgresql://h/db"),
        projectRef: Option.some("abc"),
      });
    }),
  );

  it.effect("accepts an explicit false switch", () =>
    Effect.gen(function* () {
      expect(yield* parseWith(withDbUrl, ["--linked=false"])).toMatchObject({ linked: false });
    }),
  );

  it("omits --db-url for commands without a database connection", () => {
    const storage = targetFlags({ group: "selectable", subject: "Storage API", dbUrl: false });
    expect(Object.keys(storage).sort()).toEqual(["linked", "local", "projectRef"]);
    expect(Object.keys(withDbUrl).sort()).toEqual(["dbUrl", "linked", "local", "projectRef"]);
  });

  it("describes the linked default by group", () => {
    const sync = targetFlags({ group: "sync", subject: "database", dbUrl: true });
    expect(describeFlag(sync.linked).description).toBe("Target the linked project (default).");
    expect(describeFlag(withDbUrl.linked).description).toBe(
      'Target the linked project. Default when the workspace target is "remote".',
    );
  });

  it("names the subject in the local help", () => {
    const storage = targetFlags({ group: "sync", subject: "Storage API", dbUrl: false });
    expect(describeFlag(storage.local).description).toBe("Target the local Storage API.");
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

describe("seedTargetGlobalFlags", () => {
  it("shares the selector flag names with targetFlags", () => {
    expect(describeFlag(seedTargetGlobalFlags.linked.flag).name).toBe("linked");
    expect(describeFlag(seedTargetGlobalFlags.local.flag).name).toBe("local");
  });
});
