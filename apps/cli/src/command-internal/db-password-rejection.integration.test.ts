import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";

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

const withSelector = (selector: "db-url" | "local") =>
  passwordCommands.filter((entry) => hasFlag(entry, selector));

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

const selectorArgs = (selector: "db-url" | "local" | "none") =>
  selector === "db-url"
    ? ["--db-url", "postgres://user:secret@127.0.0.1:1/postgres"]
    : selector === "local"
      ? ["--local"]
      : [];

const runCommand = (entry: WalkedCommand, selector: "db-url" | "local" | "none") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-password-rejection-" });
    const args = [
      ...entry.path,
      ...requiredFlagArgs(entry),
      "--password",
      "from-flag",
      ...selectorArgs(selector),
      "--workdir",
      home,
      "--experimental",
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
    expect(withSelector("local").length).toBeGreaterThan(5);
  });

  for (const selector of ["db-url", "local"] as const) {
    for (const entry of withSelector(selector)) {
      it.effect(`rejects ${entry.path.join(" ")} --password with --${selector}`, () =>
        Effect.gen(function* () {
          const failure = yield* runCommand(entry, selector);

          expect(failure).toMatchObject({
            _tag: "DbPasswordFlagsError",
            message:
              selector === "db-url"
                ? "--password can't be used with --db-url. Put the password in the connection string: postgres://USER:PASSWORD@HOST:PORT/postgres"
                : "--password can't be used with --local. The local database uses [db].password from supabase/config.toml.",
          });
        }),
      );
    }
  }

  it.effect("explains that migration squash defaults to local when --password has no target", () =>
    Effect.gen(function* () {
      const entry = passwordCommands.find(
        (candidate) => candidate.path.join(" ") === "migration squash",
      );
      expect(entry).toBeDefined();
      const failure = yield* runCommand(entry!, "none");

      expect(failure).toMatchObject({
        _tag: "DbPasswordFlagsError",
        message:
          "migration squash targets the local database unless you pass --linked, and --password only applies to a linked project. Pass --linked, or drop --password.",
      });
    }),
  );
});
