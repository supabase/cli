import { Effect, Layer } from "effect";
import { CliOutput, Command, type HelpDoc } from "effect/unstable/cli";
import { describe, expect, it } from "vitest";
import { legacyBranchesCommand } from "../../commands/branches/branches.command.ts";
import { legacyDbCommand } from "../../commands/db/db.command.ts";
import { legacyFunctionsCommand } from "../../commands/functions/functions.command.ts";
import { legacyFunctionsDeployCommand } from "../../commands/functions/deploy/deploy.command.ts";
import { legacyFunctionsDownloadCommand } from "../../commands/functions/download/download.command.ts";
import { legacyFunctionsServeCommand } from "../../commands/functions/serve/serve.command.ts";
import { legacyInitCommand } from "../../commands/init/init.command.ts";
import { legacyProjectsCommand } from "../../commands/projects/projects.command.ts";
import { legacyProjectsCreateCommand } from "../../commands/projects/create/create.command.ts";
import { legacyStartCommand } from "../../commands/start/start.command.ts";
import { legacyStopCommand } from "../../commands/stop/stop.command.ts";
import { mockOutput, withEnv } from "../../../tests/helpers/mocks.ts";
import { LEGACY_GLOBAL_FLAGS } from "../legacy/global-flags.ts";
import { LegacyGoProxy } from "../legacy/go-proxy.service.ts";
import { textCliOutputFormatter } from "../output/text-formatter.ts";

interface CommandImpl {
  readonly buildHelpDoc: (path: ReadonlyArray<string>) => HelpDoc.HelpDoc;
}

const buildHelpDoc = <Name extends string, Input, ContextInput, E, R>(
  cmd: Command.Command<Name, Input, ContextInput, E, R>,
): HelpDoc.HelpDoc => (cmd as unknown as CommandImpl).buildHelpDoc([]);

function mockLegacyGoProxy() {
  const calls: Array<ReadonlyArray<string>> = [];
  const layer = Layer.succeed(LegacyGoProxy, {
    exec: (args) =>
      Effect.sync(() => {
        calls.push([...args]);
      }),
    execCapture: () => Effect.succeed(""),
  });

  return { layer, calls };
}

const legacyTestRoot = Command.make("supabase").pipe(
  Command.withSubcommands([
    legacyStartCommand,
    legacyStopCommand,
    legacyInitCommand,
    legacyFunctionsCommand,
    legacyProjectsCommand,
    legacyBranchesCommand,
    legacyDbCommand,
  ]),
  Command.withGlobalFlags(LEGACY_GLOBAL_FLAGS),
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
  it("omits hidden flags from help docs for every legacy command that still carries one", () => {
    expect(buildHelpDoc(legacyStartCommand).flags.map((flag) => flag.name)).toEqual([
      "exclude",
      "ignore-health-check",
    ]);

    expect(buildHelpDoc(legacyStopCommand).flags.map((flag) => flag.name)).toEqual([
      "project-id",
      "no-backup",
      "all",
    ]);

    expect(buildHelpDoc(legacyInitCommand).flags.map((flag) => flag.name)).toEqual([
      "interactive",
      "use-orioledb",
      "force",
    ]);

    expect(buildHelpDoc(legacyFunctionsDownloadCommand).flags.map((flag) => flag.name)).toEqual([
      "project-ref",
      "use-api",
    ]);

    expect(buildHelpDoc(legacyFunctionsDeployCommand).flags.map((flag) => flag.name)).toEqual([
      "project-ref",
      "no-verify-jwt",
      "use-api",
      "import-map",
      "prune",
      "jobs",
    ]);

    expect(buildHelpDoc(legacyFunctionsServeCommand).flags.map((flag) => flag.name)).toEqual([
      "no-verify-jwt",
      "env-file",
      "import-map",
      "inspect",
      "inspect-mode",
      "inspect-main",
    ]);

    expect(buildHelpDoc(legacyProjectsCreateCommand).flags.map((flag) => flag.name)).toEqual([
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
        parserCommand(legacyFunctionsDownloadCommand, parsed),
        parserCommand(legacyFunctionsDeployCommand, parsed),
        parserCommand(legacyFunctionsServeCommand, parsed),
      ]),
    );
    const parserRoot = Command.make("supabase").pipe(
      Command.withSubcommands([
        parserCommand(legacyStartCommand, parsed),
        parserCommand(legacyStopCommand, parsed),
        parserFunctionsCommand,
      ]),
    );
    const parserLayer = Layer.mergeAll(
      withEnv({}),
      mockOutput({ format: "text" }).layer,
      CliOutput.layer(silentCliOutputFormatter),
    );
    const runParser = (args: ReadonlyArray<string>) =>
      Command.runWith(parserRoot, { version: "0.0.0-test" })(args).pipe(
        Effect.provide(parserLayer),
      );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Real commands use recorder handlers so assertions cover parser-to-handler values without runtime services.
          yield* runParser(["start", "--preview"]);
          yield* runParser(["stop", "--backup=false"]);
          // All handlers are replaced with a recorder so this stays at the parser boundary.
          yield* runParser([
            "functions",
            "download",
            "hello",
            "--project-ref",
            "abcdefghijklmnopqrst",
            "--use-docker",
          ]);
          yield* runParser([
            "functions",
            "download",
            "hello",
            "--project-ref",
            "abcdefghijklmnopqrst",
            "--legacy-bundle",
          ]);
          yield* runParser(["functions", "deploy", "hello", "--use-docker"]);
          yield* runParser(["functions", "deploy", "hello", "--legacy-bundle"]);
          yield* runParser(["functions", "serve", "--all=false"]);
        }),
      ),
    );
    expect(parsed).toEqual([
      expect.objectContaining({ preview: true }),
      expect.objectContaining({ backup: false }),
      expect.objectContaining({ useDocker: true }),
      expect.objectContaining({ legacyBundle: true }),
      expect.objectContaining({ useDocker: true }),
      expect.objectContaining({ legacyBundle: true }),
      expect.objectContaining({ all: false }),
    ]);
  });

  it("does not leak hidden flag names through unknown-flag suggestions", async () => {
    const proxy = mockLegacyGoProxy();

    const exit = await Effect.runPromise(
      Command.runWith(legacyTestRoot, { version: "0.0.0-test" })([
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

describe("legacy hidden subcommands", () => {
  it("omits hidden branch and db subcommands from help docs", () => {
    const branchesHelp = buildHelpDoc(legacyBranchesCommand);
    expect(branchesHelp.subcommands?.[0]?.commands.map((command) => command.name)).toEqual([
      "list",
      "create",
      "get",
      "update",
      "pause",
      "unpause",
      "delete",
    ]);

    const dbHelp = buildHelpDoc(legacyDbCommand);
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
    // `db branch *` / `db remote *` are still Phase 0 proxy wrappers, so a
    // successful proxy call is direct proof that cobra-style `Hidden` doesn't
    // block exact-name dispatch through `effect/unstable/cli`.
    const proxy = mockLegacyGoProxy();

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })(["db", "branch", "list"]);
        yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })([
          "db",
          "remote",
          "changes",
        ]);
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
    // `db test` was ported off the Go proxy in CLI-1962, so it no longer calls
    // `LegacyGoProxy` — this test only needs to prove dispatch still reaches the
    // real (now-native) handler, not that the handler fully succeeds (this file's
    // minimal layer doesn't wire the docker/db/telemetry services the native
    // handler needs, matching how `start`/`stop` are treated above). A genuinely
    // unresolved subcommand fails BEFORE any handler runs, with a distinct typed
    // `UnknownSubcommand` CliError; the native handler instead defects on a
    // missing service once dispatch has already succeeded — that defect is the
    // proof, mirrored against a deliberately unknown sibling subcommand below.
    const proxy = mockLegacyGoProxy();
    const layer = Layer.mergeAll(proxy.layer, CliOutput.layer(textCliOutputFormatter()));

    const causeOf = (exit: unknown) =>
      (exit as { cause: { reasons: Array<{ _tag: string; defect?: unknown; error?: unknown }> } })
        .cause;

    const dbTestExit = await Effect.runPromise(
      Command.runWith(legacyTestRoot, { version: "0.0.0-test" })(["db", "test"]).pipe(
        Effect.provide(layer),
        Effect.exit,
      ) as Effect.Effect<unknown, never, never>,
    );
    expect((dbTestExit as { _tag: string })._tag).toBe("Failure");
    // The real defect is `Error: Service not found: supabase/telemetry/Analytics`
    // — asserting it directly (rather than a negative `not.toContain` on the
    // near-empty JSON serialization of the defect) proves dispatch reached the
    // native handler and it defected on a missing ambient service, not merely
    // that the failure happens not to mention `UnknownSubcommand`.
    expect(causeOf(dbTestExit).reasons[0]?._tag).toBe("Die"); // handler ran, then defected on a missing service
    expect(String(causeOf(dbTestExit).reasons[0]?.defect)).toContain(
      "Service not found: supabase/telemetry/Analytics",
    );

    const unknownExit = await Effect.runPromise(
      Command.runWith(legacyTestRoot, { version: "0.0.0-test" })(["db", "not-a-real-command"]).pipe(
        Effect.provide(layer),
        Effect.exit,
      ) as Effect.Effect<unknown, never, never>,
    );
    // Effect CLI's raw `_tag` uses the corrected "UnknownSubcommand" spelling.
    // This assertion checks the raw, un-normalized tag so it stays aligned with
    // the upstream parser error value.
    expect(JSON.stringify(unknownExit)).toContain("UnknownSubcommand");
    expect(causeOf(unknownExit).reasons[0]?._tag).toBe("Fail"); // typed CliError, pre-handler — dispatch never reached a handler
  });
});
