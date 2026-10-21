import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Path } from "effect";
import { CliOutput, Command } from "effect/cli";

import { rootCommandForFeatures } from "../cli/root.ts";
import { CliArgs } from "../shared/cli/cli-args.service.ts";
import { textCliOutputFormatter } from "../shared/output/text-formatter.ts";
import { walkCommandTree, type WalkedCommand } from "../../tests/helpers/command-tree.ts";
import {
  mockAnalytics,
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockTelemetryRuntime,
  mockTty,
  processEnvLayer,
} from "../../tests/helpers/mocks.ts";
import { choiceKeysOf } from "../docs/docs-introspection.ts";
import { unwrapParam } from "./param-introspection.ts";

const root = rootCommandForFeatures();

const hasFlag = (entry: WalkedCommand, name: string) =>
  entry.flags.some((flag) => flag.name === name);

const isTombstone = (entry: WalkedCommand) =>
  entry.command.description?.startsWith("Removed:") === true;

const passwordCommands = walkCommandTree(root).filter(
  (entry) => hasFlag(entry, "password") && !isTombstone(entry),
);

type Selector = "db-url" | "remote-url" | "local" | "none";

const withSelector = (selector: Exclude<Selector, "none">) =>
  passwordCommands.filter((entry) => hasFlag(entry, selector === "local" ? "local" : "db-url"));

const requiredFlagArgs = (entry: WalkedCommand): ReadonlyArray<string> =>
  entry.flags.flatMap((flag) => {
    const unwrapped = unwrapParam(flag.param);
    const required =
      unwrapped !== undefined &&
      !unwrapped.isOptional &&
      !(unwrapped.isVariadic && unwrapped.variadicMin === 0) &&
      unwrapped.single.primitiveType._tag !== "Boolean";
    if (!required) return [];
    const [firstChoice] = choiceKeysOf(unwrapped.single.primitiveType) ?? [];
    return [`--${flag.name}`, firstChoice ?? "value"];
  });

const DIRECT_URL = "postgres://user:secret@127.0.0.1:1/postgres";

const selectorArgs = (selector: Selector) => {
  switch (selector) {
    case "db-url":
      return ["--db-url", DIRECT_URL];
    case "remote-url":
      return [`--remote=${DIRECT_URL}`];
    case "local":
      return ["--local"];
    case "none":
      return [];
  }
};

const runCommand = (
  entry: WalkedCommand,
  selector: Selector,
  options: { readonly linked?: boolean } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-password-rejection-" });
    if (options.linked === true) {
      yield* fs.makeDirectory(path.join(home, "supabase", ".temp"), { recursive: true });
      yield* fs.writeFileString(
        path.join(home, "supabase", ".temp", "project-ref"),
        "abcdefghijklmnopqrst",
      );
    }
    const args = [
      ...entry.path,
      ...requiredFlagArgs(entry),
      "--password",
      "from-flag",
      ...selectorArgs(selector),
      "--workdir",
      home,
      // `db pull` rejects `--experimental` without `--declarative` before it validates the password.
      ...(entry.path.join(" ") === "db pull" ? [] : ["--experimental"]),
    ];
    const exit = yield* Command.runWith(root, { version: "0.0.0-test" })(args).pipe(
      Effect.provide(
        Layer.mergeAll(
          CliOutput.layer(textCliOutputFormatter()),
          Layer.succeed(CliArgs, { args }),
          mockOutput({ format: "text" }).layer,
          BunServices.layer,
          mockRuntimeInfo(),
          mockAnalytics().layer,
          mockTelemetryRuntime(),
          mockTty(),
          mockProcessControl().layer,
          processEnvLayer({ SUPABASE_HOME: home }),
        ),
      ),
      Effect.exit,
    );
    return Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

describe("--password with a direct database target", () => {
  it("is discovered on commands that accept a direct target", () => {
    expect(passwordCommands.length).toBeGreaterThan(5);
    expect(withSelector("db-url").length).toBeGreaterThan(5);
    expect(withSelector("remote-url").length).toBeGreaterThan(5);
    expect(withSelector("local").length).toBeGreaterThan(5);
  });

  for (const selector of ["db-url", "remote-url", "local"] as const) {
    for (const entry of withSelector(selector)) {
      it.effect(
        `rejects ${entry.path.join(" ")} --password with ${selector === "remote-url" ? "--remote=<url>" : `--${selector}`}`,
        () =>
          Effect.gen(function* () {
            const failure = yield* runCommand(entry, selector);

            expect(failure).toMatchObject({
              _tag: "TargetPasswordConflictError",
              message:
                selector === "local"
                  ? "--password only applies to a linked project. The local database uses [db].password from supabase/config.toml."
                  : "--password can't be used with --remote=<db-url>. Put the password in the connection string: postgres://USER:PASSWORD@HOST:PORT/postgres",
            });
          }),
      );
    }
  }

  it.effect("rejects migration squash --password when no target is selected", () =>
    Effect.gen(function* () {
      const entry = passwordCommands.find(
        (candidate) => candidate.path.join(" ") === "migration squash",
      );
      expect(entry).toBeDefined();
      const failure = yield* runCommand(entry!, "none");

      expect(failure).toMatchObject({
        _tag: "TargetPasswordConflictError",
        message:
          "--password only applies to a linked project. The local database uses [db].password from supabase/config.toml.",
      });
    }),
  );

  it.effect("points a local --password rejection at --remote when the checkout is linked", () =>
    Effect.gen(function* () {
      const entry = passwordCommands.find(
        (candidate) => candidate.path.join(" ") === "migration list",
      );
      expect(entry).toBeDefined();
      const failure = yield* runCommand(entry!, "local", { linked: true });

      expect(failure).toMatchObject({
        _tag: "TargetPasswordConflictError",
        message:
          "--password only applies to a linked project. The local database uses [db].password from supabase/config.toml. To use the linked project instead, pass --remote.",
      });
    }),
  );
});
