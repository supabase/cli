import { Effect, Layer } from "effect";
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
import { VALID_TOKEN } from "../../../tests/helpers/command-mocks.ts";
import { mockOutput, withEnv } from "../../../tests/helpers/mocks.ts";
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

const silentCliOutputFormatter: CliOutput.Formatter = {
  formatCliError: () => "",
  formatError: () => "",
  formatErrors: () => "",
  formatHelpDoc: () => "",
  formatVersion: () => "",
};

const authenticatedEnv = {
  SUPABASE_ACCESS_TOKEN: VALID_TOKEN,
  ...(process.env["SystemRoot"] === undefined ? {} : { SystemRoot: process.env["SystemRoot"] }),
};

describe("native hidden flags", () => {
  it("omits hidden flags from help docs for every legacy command that still carries one", () => {
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

  it("still parses and forwards every hidden flag by exact name", async () => {
    const proxy = mockGoProxy();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // `start` and `stop` are both natively ported (no longer `GoProxy` forwards),
          // so they can fail for workdir/Docker-related reasons in this proxy-only test layer —
          // the point here is only to prove the hidden `--preview`/`--backup` flags still parse
          // by exact name, not that the commands succeed, matching the `functions deploy`/`serve`
          // assertions below.
          const startExit = yield* Command.runWith(testRoot, { version: "0.0.0-test" })([
            "start",
            "--preview",
          ]).pipe(Effect.exit);
          expect(JSON.stringify(startExit)).not.toContain("UnrecognizedFlag");
          const stopExit = yield* Command.runWith(testRoot, { version: "0.0.0-test" })([
            "stop",
            "--backup=false",
          ]).pipe(Effect.exit);
          expect(JSON.stringify(stopExit)).not.toContain("UnrecognizedFlag");
          // `functions download --use-docker` now runs the native Docker-unbundle
          // path (CLI-1963) instead of forwarding to `GoProxy` — the
          // deliberately-invalid slug makes it fail at `validateSlug`
          // (`download.ts`, checked BEFORE `isDockerRunning`/any image pull),
          // so the invocation stays fast and side-effect-free even on a CI
          // runner with a live Docker daemon (a valid slug here triggered a
          // real multi-second `docker pull` and timed this test out), while
          // still proving the hidden flag parses by exact name.
          // `--legacy-bundle` is the one remaining case that still forwards to the
          // proxy, asserted below.
          const downloadUseDockerExit = yield* Command.runWith(testRoot, {
            version: "0.0.0-test",
          })([
            "functions",
            "download",
            "Not_A_Valid-Slug!",
            "--project-ref",
            "abcdefghijklmnopqrst",
            "--use-docker",
          ]).pipe(Effect.exit);
          expect(JSON.stringify(downloadUseDockerExit)).not.toContain("UnrecognizedFlag");
          yield* Command.runWith(testRoot, { version: "0.0.0-test" })([
            "functions",
            "download",
            "hello",
            "--project-ref",
            "abcdefghijklmnopqrst",
            "--legacy-bundle",
          ]);
          const useDockerExit = yield* Command.runWith(testRoot, {
            version: "0.0.0-test",
          })(["functions", "deploy", "hello", "--use-docker"]).pipe(Effect.exit);
          const legacyBundleExit = yield* Command.runWith(testRoot, {
            version: "0.0.0-test",
          })(["functions", "deploy", "hello", "--legacy-bundle"]).pipe(Effect.exit);
          expect(JSON.stringify(useDockerExit)).not.toContain("UnrecognizedFlag");
          expect(JSON.stringify(legacyBundleExit)).not.toContain("UnrecognizedFlag");
          const serveExit = yield* Command.runWith(testRoot, {
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
      [
        "functions",
        "download",
        "hello",
        "--project-ref",
        "abcdefghijklmnopqrst",
        "--legacy-bundle",
      ],
    ]);
    // Guard, not a correctness assertion: this test drives 8 full command
    // invocations through the real CLI tree, which can exceed the 5s default
    // under CI file-level parallelism on a loaded runner.
  }, 30_000);

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

describe("legacy hidden subcommands", () => {
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
    // `db branch *` / `db remote *` are still Phase 0 proxy wrappers, so a
    // successful proxy call is direct proof that cobra-style `Hidden` doesn't
    // block exact-name dispatch through `effect/unstable/cli`.
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
    // `db test` was ported off the Go proxy in CLI-1962, so it no longer calls
    // `GoProxy` — this test only needs to prove dispatch still reaches the
    // real (now-native) handler, not that the handler fully succeeds (this file's
    // minimal layer doesn't wire the docker/db/telemetry services the native
    // handler needs, matching how `start`/`stop` are treated above). A genuinely
    // unresolved subcommand fails BEFORE any handler runs, with a distinct typed
    // `UnknownSubcommand` CliError; the native handler instead defects on a
    // missing service once dispatch has already succeeded — that defect is the
    // proof, mirrored against a deliberately unknown sibling subcommand below.
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
      Command.runWith(testRoot, { version: "0.0.0-test" })(["db", "not-a-real-command"]).pipe(
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
