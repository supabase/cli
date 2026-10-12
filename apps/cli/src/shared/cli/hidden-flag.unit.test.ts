import { Cause, Effect, Exit, FileSystem, Layer, Option, Schema, Stdio } from "effect";
import { BunServices } from "@effect/platform-bun";
import { CliOutput, Command, type HelpDoc } from "effect/cli";
import { describe, expect, it } from "@effect/vitest";
import { branchesCommand } from "../../commands/branches/branches.command.ts";
import { dbCommand } from "../../commands/db/db.command.ts";
import { dbDiffCommand } from "../../commands/db/diff/diff.command.ts";
import { functionsCommand } from "../../commands/functions/functions.command.ts";
import { functionsDeployCommand } from "../../commands/functions/deploy/deploy.command.ts";
import { functionsDownloadCommand } from "../../commands/functions/download/download.command.ts";
import { functionsServeCommand } from "../../commands/functions/serve/serve.command.ts";
import { genCommand } from "../../commands/gen/gen.command.ts";
import { initCommand } from "../../commands/init/init.command.ts";
import { issueCommand } from "../../commands/issue/issue.command.ts";
import { projectsCommand } from "../../commands/projects/projects.command.ts";
import { projectsCreateCommand } from "../../commands/projects/create/create.command.ts";
import { startCommand } from "../../commands/start/start.command.ts";
import { stopCommand } from "../../commands/stop/stop.command.ts";
import { GLOBAL_FLAGS } from "../../command-internal/global-flags.ts";
import { RemovedSurfaceError } from "../../command-internal/removed-command.ts";
import { TestDbMutuallyExclusiveFlagsError } from "../../command-internal/test-db.errors.ts";
import {
  mockAnalytics,
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockTelemetryRuntime,
  mockTty,
  processEnvLayer,
} from "../../../tests/helpers/mocks.ts";
import { textCliOutputFormatter } from "../output/text-formatter.ts";
import { CliArgs } from "./cli-args.service.ts";

interface CommandImpl {
  readonly buildHelpDoc: (path: ReadonlyArray<string>) => HelpDoc.HelpDoc;
}

const buildHelpDoc = <Name extends string, Input, ContextInput, E, R>(
  cmd: Command.Command<Name, Input, ContextInput, E, R>,
): HelpDoc.HelpDoc => (cmd as unknown as CommandImpl).buildHelpDoc([]);

const testRootLayer = (formatter: CliOutput.Formatter, args: ReadonlyArray<string>) =>
  Layer.mergeAll(
    CliOutput.layer(formatter),
    Layer.succeed(CliArgs, { args }),
    mockOutput({ format: "text" }).layer,
    BunServices.layer,
    mockRuntimeInfo(),
    mockAnalytics().layer,
    mockTelemetryRuntime(),
    mockTty(),
    mockProcessControl().layer,
  );

const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([
    startCommand,
    stopCommand,
    initCommand,
    functionsCommand,
    genCommand,
    projectsCommand,
    branchesCommand,
    dbCommand,
    issueCommand,
  ]),
  Command.withGlobalFlags(GLOBAL_FLAGS),
);

function parserCommand<Name extends string, Input, ContextInput, E, R>(
  command: Command.Command<Name, Input, ContextInput, E, R>,
  parsed: Array<unknown>,
) {
  return command.pipe(
    Command.withHandler((flags) =>
      Effect.sync(() => {
        parsed.push(flags);
      }),
    ),
  );
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const silentCliOutputFormatter: CliOutput.Formatter = {
  formatCliError: () => "",
  formatError: () => "",
  formatErrors: () => "",
  formatHelpDoc: () => "",
  formatVersion: () => "",
};

describe("native hidden flags", () => {
  it("omits hidden flags from help docs for every command that still carries one", () => {
    expect(buildHelpDoc(startCommand).flags.map((flag) => flag.name)).toEqual([
      "exclude",
      "ignore-health-check",
    ]);

    expect(buildHelpDoc(stopCommand).flags.map((flag) => flag.name)).toEqual([
      "project-id",
      "no-backup",
      "all",
    ]);

    expect(buildHelpDoc(initCommand).flags.map((flag) => flag.name)).toEqual([
      "interactive",
      "use-orioledb",
      "force",
    ]);

    expect(buildHelpDoc(functionsDownloadCommand).flags.map((flag) => flag.name)).toEqual([
      "project-ref",
      "use-api",
    ]);

    expect(buildHelpDoc(functionsDeployCommand).flags.map((flag) => flag.name)).toEqual([
      "project-ref",
      "no-verify-jwt",
      "use-api",
      "import-map",
      "prune",
      "jobs",
    ]);

    expect(buildHelpDoc(functionsServeCommand).flags.map((flag) => flag.name)).toEqual([
      "no-verify-jwt",
      "env-file",
      "import-map",
      "inspect",
      "inspect-mode",
      "inspect-main",
    ]);

    expect(buildHelpDoc(projectsCreateCommand).flags.map((flag) => flag.name)).toEqual([
      "org-id",
      "db-password",
      "region",
      "size",
      "high-availability",
    ]);

    expect(buildHelpDoc(dbDiffCommand).flags.map((flag) => flag.name)).not.toContain(
      "use-pg-schema",
    );
  });

  it.effect("passes hidden flag values to handlers by exact name", () => {
    const parsed: Array<unknown> = [];
    const parserFunctionsCommand = Command.make("functions").pipe(
      Command.withSubcommands([
        parserCommand(functionsDownloadCommand, parsed),
        parserCommand(functionsDeployCommand, parsed),
        parserCommand(functionsServeCommand, parsed),
      ]),
    );
    const parserRoot = Command.make("supabase").pipe(
      Command.withSubcommands([
        parserCommand(startCommand, parsed),
        parserCommand(stopCommand, parsed),
        parserFunctionsCommand,
      ]),
    );
    const parserLayer = Layer.mergeAll(
      BunServices.layer,
      CliOutput.layer(silentCliOutputFormatter),
    );
    const runParser = (args: ReadonlyArray<string>) =>
      Command.runWith(parserRoot, { version: "0.0.0-test" })(args).pipe(
        Effect.provide(parserLayer),
      );

    return Effect.gen(function* () {
      // Recorder handlers cover parser-to-handler values without running command runtimes.
      yield* runParser(["start", "--preview"]);
      yield* runParser(["stop", "--backup=false"]);
      yield* runParser([
        "functions",
        "download",
        "hello",
        "--project-ref",
        "abcdefghijklmnopqrst",
        "--use-docker=false",
      ]);
      yield* runParser(["functions", "download", "hello", "--legacy-bundle"]);
      yield* runParser(["functions", "deploy", "hello", "--use-docker=false"]);
      yield* runParser(["functions", "deploy", "hello", "--legacy-bundle"]);
      yield* runParser(["functions", "serve", "--all=false"]);
      expect(parsed).toEqual([
        expect.objectContaining({ preview: true }),
        expect.objectContaining({ backup: false }),
        expect.objectContaining({ useDocker: false }),
        expect.objectContaining({ legacyBundle: Option.some(true) }),
        expect.objectContaining({ useDocker: false }),
        expect.objectContaining({ legacyBundle: true }),
        expect.objectContaining({ all: false }),
      ]);
    });
  });

  it.effect("does not leak hidden flag names through unknown-flag suggestions", () =>
    Effect.gen(function* () {
      const args = ["projects", "create", "demo", "--pla"];

      const exit = yield* Command.runWith(testRoot, { version: "0.0.0-test" })(args).pipe(
        Effect.provide(testRootLayer(silentCliOutputFormatter, args)),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      const exitJson = yield* encodeJson(exit);
      expect(exitJson).toContain('"suggestions":[]');
      expect(exitJson).not.toContain("--plan");
    }),
  );
});

describe("hidden subcommands", () => {
  it("omits hidden branch and db subcommands from help docs", () => {
    const branchesHelp = buildHelpDoc(branchesCommand);
    expect(branchesHelp.subcommands?.[0]?.commands.map((command) => command.name)).toEqual([
      "list",
      "create",
      "get",
      "update",
      "pause",
      "unpause",
      "delete",
    ]);

    const dbHelp = buildHelpDoc(dbCommand);
    expect(dbHelp.subcommands?.[0]?.commands.map((command) => command.name)).toEqual([
      "diff",
      "dump",
      "push",
      "pull",
      "reset",
      "lint",
      "start",
      "query",
      "advisors",
      "schema",
    ]);
  });

  it.effect("still executes hidden tombstoned subcommands by exact name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-hidden-flag-tombstone-" });

      for (const args of [
        ["db", "branch", "list"],
        ["db", "remote", "changes"],
        ["gen", "keys"],
      ]) {
        const exit = yield* Command.runWith(testRoot, { version: "0.0.0-test" })(args).pipe(
          Effect.provide(
            Layer.merge(
              testRootLayer(textCliOutputFormatter(), args),
              processEnvLayer({ SUPABASE_HOME: home }),
            ),
          ),
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) return;
        expect(Cause.squash(exit.cause)).toBeInstanceOf(RemovedSurfaceError);
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("still executes the native `db test` hidden alias by exact name (CLI-1962)", () =>
    Effect.gen(function* () {
      // `--local --linked` fail inside the native handler's mutual-exclusivity check before any
      // DB/docker IO, so that typed failure (not success) is what proves dispatch reached it.
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-hidden-flag-" });
      const run = (args: ReadonlyArray<string>) =>
        Command.runWith(testRoot, { version: "0.0.0-test" })(args).pipe(
          Effect.provide(testRootLayer(textCliOutputFormatter(), args)),
          Effect.exit,
        );

      const dbTestExit = yield* run(["db", "test", "--local", "--linked"]).pipe(
        Effect.provide(processEnvLayer({ SUPABASE_HOME: home })),
      );
      expect(Exit.isFailure(dbTestExit)).toBe(true);
      if (!Exit.isFailure(dbTestExit)) return;
      expect(Cause.squash(dbTestExit.cause)).toBeInstanceOf(TestDbMutuallyExclusiveFlagsError);

      const unknownExit = yield* run(["db", "not-a-real-command"]);
      expect(yield* encodeJson(unknownExit)).toContain("UnknownSubcommand");
      expect(Exit.isFailure(unknownExit)).toBe(true);
      if (!Exit.isFailure(unknownExit)) return;
      expect(Cause.hasFails(unknownExit.cause)).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("removed global flags", () => {
  it.effect("hides --create-ticket from GLOBAL FLAGS help", () =>
    Effect.gen(function* () {
      const args = ["issue", "bug", "--help"];
      let globalFlagNames: ReadonlyArray<string> = [];
      const capturingFormatter: CliOutput.Formatter = {
        ...silentCliOutputFormatter,
        formatHelpDoc: (doc) => {
          globalFlagNames = doc.globalFlags?.map((flag) => flag.name) ?? [];
          return "";
        },
      };

      yield* Command.runWith(testRoot, { version: "0.0.0-test" })(args).pipe(
        Effect.provide(testRootLayer(capturingFormatter, args)),
      );

      expect(globalFlagNames).toContain("debug");
      expect(globalFlagNames).not.toContain("create-ticket");
    }),
  );

  it.effect(
    "fails a command passed --create-ticket with the removal error, not a parse error",
    () =>
      Effect.gen(function* () {
        const args = ["issue", "bug", "--no-browser", "--create-ticket"];
        const analytics = mockAnalytics();

        const exit = yield* Command.runWith(testRoot, { version: "0.0.0-test" })(args).pipe(
          Effect.provide(
            Layer.mergeAll(
              testRootLayer(textCliOutputFormatter(), args),
              analytics.layer,
              Stdio.layerTest({ args: Effect.succeed(args) }),
            ),
          ),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) return;
        const error = Cause.squash(exit.cause);
        expect(error).toBeInstanceOf(RemovedSurfaceError);
        if (!(error instanceof RemovedSurfaceError)) return;
        expect(error.kind).toBe("flag");
        expect(error.message).toBe("--create-ticket was removed.");
        expect(analytics.captured.map((event) => event.event)).toEqual(["cli_command_executed"]);
        expect(analytics.captured[0]?.properties).toMatchObject({
          error_fingerprint: "tag:RemovedSurfaceError:removed_flag",
        });
      }),
  );
});
