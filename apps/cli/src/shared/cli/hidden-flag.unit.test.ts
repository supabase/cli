import { Effect, Layer } from "effect";
import { BunServices } from "@effect/platform-bun";
import { CliOutput, Command, type HelpDoc } from "effect/unstable/cli";
import { describe, expect, it } from "vitest";
import { branchesCommand } from "../../commands/branches/branches.command.ts";
import { dbCommand } from "../../commands/db/db.command.ts";
import { functionsCommand } from "../../commands/functions/functions.command.ts";
import { functionsDeployCommand } from "../../commands/functions/deploy/deploy.command.ts";
import { functionsDownloadCommand } from "../../commands/functions/download/download.command.ts";
import { functionsServeCommand } from "../../commands/functions/serve/serve.command.ts";
import { initCommand } from "../../commands/init/init.command.ts";
import { projectsCommand } from "../../commands/projects/projects.command.ts";
import { projectsCreateCommand } from "../../commands/projects/create/create.command.ts";
import { startCommand } from "../../commands/start/start.command.ts";
import { stopCommand } from "../../commands/stop/stop.command.ts";
import { GLOBAL_FLAGS } from "../../command-internal/global-flags.ts";
import { GoProxy } from "../../command-internal/go-proxy.service.ts";
import { textCliOutputFormatter } from "../output/text-formatter.ts";

interface CommandImpl {
  readonly buildHelpDoc: (path: ReadonlyArray<string>) => HelpDoc.HelpDoc;
}

const buildHelpDoc = <Name extends string, Input, ContextInput, E, R>(
  cmd: Command.Command<Name, Input, ContextInput, E, R>,
): HelpDoc.HelpDoc => (cmd as unknown as CommandImpl).buildHelpDoc([]);

function mockGoProxy() {
  const calls: Array<ReadonlyArray<string>> = [];
  const layer = Layer.succeed(GoProxy, {
    exec: (args) =>
      Effect.sync(() => {
        calls.push([...args]);
      }),
    execCapture: () => Effect.succeed(""),
  });

  return { layer, calls };
}

const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([
    startCommand,
    stopCommand,
    initCommand,
    functionsCommand,
    projectsCommand,
    branchesCommand,
    dbCommand,
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
  });

  it("passes hidden flag values to handlers by exact name", async () => {
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

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
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
          yield* runParser([
            "functions",
            "download",
            "hello",
            "--project-ref",
            "abcdefghijklmnopqrst",
            "--legacy-bundle",
          ]);
          yield* runParser(["functions", "deploy", "hello", "--use-docker=false"]);
          yield* runParser(["functions", "deploy", "hello", "--legacy-bundle"]);
          yield* runParser(["functions", "serve", "--all=false"]);
        }),
      ),
    );
    expect(parsed).toEqual([
      expect.objectContaining({ preview: true }),
      expect.objectContaining({ backup: false }),
      expect.objectContaining({ useDocker: false }),
      expect.objectContaining({ legacyBundle: true }),
      expect.objectContaining({ useDocker: false }),
      expect.objectContaining({ legacyBundle: true }),
      expect.objectContaining({ all: false }),
    ]);
  });

  it("does not leak hidden flag names through unknown-flag suggestions", async () => {
    const proxy = mockGoProxy();

    const exit = await Effect.runPromise(
      Command.runWith(testRoot, { version: "0.0.0-test" })([
        "projects",
        "create",
        "demo",
        "--pla",
      ]).pipe(
        Effect.provide(Layer.mergeAll(proxy.layer, CliOutput.layer(silentCliOutputFormatter))),
        Effect.exit,
      ) as Effect.Effect<unknown, never, never>,
    );

    expect((exit as { _tag: string })._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain('"suggestions":[]');
    expect(JSON.stringify(exit)).not.toContain("--plan");
  });
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

  it("still executes hidden subcommands by exact name", async () => {
    const proxy = mockGoProxy();

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Command.runWith(testRoot, { version: "0.0.0-test" })(["db", "branch", "list"]);
        yield* Command.runWith(testRoot, { version: "0.0.0-test" })(["db", "remote", "changes"]);
      }).pipe(
        Effect.provide(Layer.mergeAll(proxy.layer, CliOutput.layer(textCliOutputFormatter()))),
      ) as Effect.Effect<void>,
    );

    expect(proxy.calls).toEqual([
      ["db", "branch", "list"],
      ["db", "remote", "changes"],
    ]);
  });

  it("still executes the native `db test` hidden alias by exact name (CLI-1962)", async () => {
    // This test's minimal layer doesn't wire the services the native handler needs, so dispatch
    // reaching the handler (a Die on a missing service, not success) is what's being proven.
    const proxy = mockGoProxy();
    const layer = Layer.mergeAll(proxy.layer, CliOutput.layer(textCliOutputFormatter()));

    const causeOf = (exit: unknown) =>
      (exit as { cause: { reasons: Array<{ _tag: string; defect?: unknown; error?: unknown }> } })
        .cause;

    const dbTestExit = await Effect.runPromise(
      Command.runWith(testRoot, { version: "0.0.0-test" })(["db", "test"]).pipe(
        Effect.provide(layer),
        Effect.exit,
      ) as Effect.Effect<unknown, never, never>,
    );
    expect((dbTestExit as { _tag: string })._tag).toBe("Failure");
    expect(causeOf(dbTestExit).reasons[0]?._tag).toBe("Die");
    expect(String(causeOf(dbTestExit).reasons[0]?.defect)).toContain(
      "Service not found: supabase/telemetry/Analytics",
    );

    const unknownExit = await Effect.runPromise(
      Command.runWith(testRoot, { version: "0.0.0-test" })(["db", "not-a-real-command"]).pipe(
        Effect.provide(layer),
        Effect.exit,
      ) as Effect.Effect<unknown, never, never>,
    );
    expect(JSON.stringify(unknownExit)).toContain("UnknownSubcommand");
    expect(causeOf(unknownExit).reasons[0]?._tag).toBe("Fail");
  });
});
