import { Effect, Layer } from "effect";
import { CliOutput, Command, type HelpDoc } from "effect/unstable/cli";
import { describe, expect, it } from "vitest";
import { legacyBranchesCommand } from "../../legacy/commands/branches/branches.command.ts";
import { legacyDbCommand } from "../../legacy/commands/db/db.command.ts";
import { legacyFunctionsCommand } from "../../legacy/commands/functions/functions.command.ts";
import { legacyFunctionsDeployCommand } from "../../legacy/commands/functions/deploy/deploy.command.ts";
import { legacyFunctionsDownloadCommand } from "../../legacy/commands/functions/download/download.command.ts";
import { legacyFunctionsServeCommand } from "../../legacy/commands/functions/serve/serve.command.ts";
import { legacyInitCommand } from "../../legacy/commands/init/init.command.ts";
import { legacyProjectsCommand } from "../../legacy/commands/projects/projects.command.ts";
import { legacyProjectsCreateCommand } from "../../legacy/commands/projects/create/create.command.ts";
import { legacyStartCommand } from "../../legacy/commands/start/start.command.ts";
import { legacyStopCommand } from "../../legacy/commands/stop/stop.command.ts";
import { LEGACY_VALID_TOKEN } from "../../../tests/helpers/legacy-mocks.ts";
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
  Command.withGlobalFlags(LEGACY_GLOBAL_FLAGS),
  Command.withSubcommands([
    legacyStartCommand,
    legacyStopCommand,
    legacyInitCommand,
    legacyFunctionsCommand,
    legacyProjectsCommand,
    legacyBranchesCommand,
    legacyDbCommand,
  ]),
);

const silentCliOutputFormatter: CliOutput.Formatter = {
  formatCliError: () => "",
  formatError: () => "",
  formatErrors: () => "",
  formatHelpDoc: () => "",
  formatVersion: () => "",
};

const authenticatedEnv = {
  SUPABASE_ACCESS_TOKEN: LEGACY_VALID_TOKEN,
  ...(process.env["SystemRoot"] === undefined ? {} : { SystemRoot: process.env["SystemRoot"] }),
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

  it("still parses and forwards every hidden flag by exact name", async () => {
    const proxy = mockLegacyGoProxy();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })(["start", "--preview"]);
          yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })([
            "stop",
            "--backup=false",
          ]);
          yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })([
            "functions",
            "download",
            "hello",
            "--project-ref",
            "abcdefghijklmnopqrst",
            "--use-docker",
          ]);
          const useDockerExit = yield* Command.runWith(legacyTestRoot, {
            version: "0.0.0-test",
          })(["functions", "deploy", "hello", "--use-docker"]).pipe(Effect.exit);
          const legacyBundleExit = yield* Command.runWith(legacyTestRoot, {
            version: "0.0.0-test",
          })(["functions", "deploy", "hello", "--legacy-bundle"]).pipe(Effect.exit);
          expect(JSON.stringify(useDockerExit)).not.toContain("UnrecognizedFlag");
          expect(JSON.stringify(legacyBundleExit)).not.toContain("UnrecognizedFlag");
          const serveExit = yield* Command.runWith(legacyTestRoot, {
            version: "0.0.0-test",
          })(["functions", "serve", "--all=false"]).pipe(Effect.exit);
          expect(JSON.stringify(serveExit)).not.toContain("UnrecognizedFlag");
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            withEnv(authenticatedEnv),
            proxy.layer,
            mockOutput({ format: "text" }).layer,
            CliOutput.layer(textCliOutputFormatter()),
          ),
        ),
      ) as Effect.Effect<void>,
    );

    expect(proxy.calls).toEqual([
      ["start", "--preview"],
      ["stop", "--backup=false"],
      ["functions", "download", "hello", "--project-ref", "abcdefghijklmnopqrst", "--use-docker"],
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
    const proxy = mockLegacyGoProxy();

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })(["db", "test"]);
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
      ["db", "test"],
      ["db", "branch", "list"],
      ["db", "remote", "changes"],
    ]);
  });
});
