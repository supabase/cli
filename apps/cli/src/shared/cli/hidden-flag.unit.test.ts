import { BunServices } from "@effect/platform-bun";
import { Cause, ConfigProvider, Effect, Exit, Layer, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { CliOutput, Command, type HelpDoc } from "effect/unstable/cli";
import { describe, expect, it } from "@effect/vitest";
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
import {
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockStdin,
  mockTelemetryRuntime,
  mockTty,
  withEnv,
} from "../../../tests/helpers/mocks.ts";
import { LEGACY_GLOBAL_FLAGS } from "../legacy/global-flags.ts";
import { LegacyGoProxy } from "../legacy/go-proxy.service.ts";
import { LegacyPlatformApiFactory } from "../../legacy/auth/legacy-platform-api-factory.service.ts";
import { legacyLocalGatewayHttpClientTestLayer } from "../../legacy/shared/legacy-local-gateway-http-client.ts";
import { makeLegacyViperEnvLayer } from "../legacy/legacy-viper-env.ts";
import { textCliOutputFormatter } from "../output/text-formatter.ts";
import { CliArgs } from "./cli-args.service.ts";
import { Analytics } from "../telemetry/analytics.service.ts";

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

function unavailableAnalyticsLayer() {
  const missing = () => Effect.die("Service not found: supabase/telemetry/Analytics");
  return Layer.succeed(
    Analytics,
    Analytics.of({
      capture: missing,
      identify: missing,
      alias: missing,
      groupIdentify: missing,
    }),
  );
}

function hiddenCommandLayer(proxy: Layer.Layer<LegacyGoProxy>, useEnvironment = true) {
  const httpClientLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("unexpected local gateway request in hidden-flag test")),
  );
  const runtimeLayer = useEnvironment
    ? withEnv(authenticatedEnv)
    : Layer.mergeAll(
        BunServices.layer,
        mockRuntimeInfo(),
        mockTty({ stdinIsTty: false, stdoutIsTty: false }),
        mockProcessControl().layer,
        mockTelemetryRuntime(),
      );
  return Layer.mergeAll(
    runtimeLayer,
    makeLegacyViperEnvLayer(
      ConfigProvider.fromEnv({ env: authenticatedEnv, preserveEmptyStrings: true }),
    ),
    proxy,
    mockOutput({ format: "text" }).layer,
    CliOutput.layer(textCliOutputFormatter()),
    Layer.succeed(CliArgs, { args: [] }),
    mockStdin(false),
    Layer.succeed(LegacyPlatformApiFactory, {
      make: Effect.die("unexpected management API access in hidden-flag test"),
    }),
    legacyLocalGatewayHttpClientTestLayer(httpClientLayer),
    ...(useEnvironment ? [] : [unavailableAnalyticsLayer()]),
  );
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

const silentCliOutputFormatter: CliOutput.Formatter = {
  formatCliError: () => "",
  formatError: () => "",
  formatErrors: () => "",
  formatHelpDoc: () => "",
  formatVersion: () => "",
};

const authenticatedEnv = { SUPABASE_ACCESS_TOKEN: LEGACY_VALID_TOKEN };
const encodeJsonText = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

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

  it.effect("still parses and forwards every hidden flag by exact name", () => {
    const proxy = mockLegacyGoProxy();

    return Effect.scoped(
      Effect.gen(function* () {
        // `start` and `stop` are both natively ported (no longer `LegacyGoProxy` forwards),
        // so they can fail for workdir/Docker-related reasons in this proxy-only test layer —
        // the point here is only to prove the hidden `--preview`/`--backup` flags still parse
        // by exact name, not that the commands succeed, matching the `functions deploy`/`serve`
        // assertions below.
        const startExit = yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })([
          "start",
          "--preview",
        ]).pipe(Effect.exit);
        expect(encodeJsonText(startExit)).not.toContain("UnrecognizedFlag");
        const stopExit = yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })([
          "stop",
          "--backup=false",
        ]).pipe(Effect.exit);
        expect(encodeJsonText(stopExit)).not.toContain("UnrecognizedFlag");
        // `functions download --use-docker` now runs the native Docker-unbundle
        // path (CLI-1963) instead of forwarding to `LegacyGoProxy` — the
        // deliberately-invalid slug makes it fail at `validateSlug`
        // (`download.ts`, checked BEFORE `isDockerRunning`/any image pull),
        // so the invocation stays fast and side-effect-free even on a CI
        // runner with a live Docker daemon (a valid slug here triggered a
        // real multi-second `docker pull` and timed this test out), while
        // still proving the hidden flag parses by exact name.
        // `--legacy-bundle` is the one remaining case that still forwards to the
        // proxy, asserted below.
        const downloadUseDockerExit = yield* Command.runWith(legacyTestRoot, {
          version: "0.0.0-test",
        })([
          "functions",
          "download",
          "Not_A_Valid-Slug!",
          "--project-ref",
          "abcdefghijklmnopqrst",
          "--use-docker",
        ]).pipe(Effect.exit);
        expect(encodeJsonText(downloadUseDockerExit)).not.toContain("UnrecognizedFlag");
        yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })([
          "functions",
          "download",
          "hello",
          "--project-ref",
          "abcdefghijklmnopqrst",
          "--legacy-bundle",
        ]);
        const useDockerExit = yield* Command.runWith(legacyTestRoot, {
          version: "0.0.0-test",
        })(["functions", "deploy", "hello", "--use-docker"]).pipe(Effect.exit);
        const legacyBundleExit = yield* Command.runWith(legacyTestRoot, {
          version: "0.0.0-test",
        })(["functions", "deploy", "hello", "--legacy-bundle"]).pipe(Effect.exit);
        expect(encodeJsonText(useDockerExit)).not.toContain("UnrecognizedFlag");
        expect(encodeJsonText(legacyBundleExit)).not.toContain("UnrecognizedFlag");
        const serveExit = yield* Command.runWith(legacyTestRoot, {
          version: "0.0.0-test",
        })(["functions", "serve", "--all=false"]).pipe(Effect.exit);
        expect(encodeJsonText(serveExit)).not.toContain("UnrecognizedFlag");
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
      }),
    ).pipe(Effect.provide(hiddenCommandLayer(proxy.layer)));
  });

  it.effect("does not leak hidden flag names through unknown-flag suggestions", () => {
    const proxy = mockLegacyGoProxy();

    return Effect.gen(function* () {
      const exit = yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })([
        "projects",
        "create",
        "demo",
        "--pla",
      ]).pipe(
        Effect.provide(
          Layer.mergeAll(
            hiddenCommandLayer(proxy.layer, false),
            CliOutput.layer(silentCliOutputFormatter),
          ),
        ),
        Effect.exit,
      );

      expect(encodeJsonText(exit)).toContain('"suggestions":[]');
      expect(encodeJsonText(exit)).not.toContain("--plan");
    });
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

  it.effect("still executes hidden subcommands by exact name", () => {
    // `db branch *` / `db remote *` are still Phase 0 proxy wrappers, so a
    // successful proxy call is direct proof that cobra-style `Hidden` doesn't
    // block exact-name dispatch through `effect/unstable/cli`.
    const proxy = mockLegacyGoProxy();

    return Effect.gen(function* () {
      yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })(["db", "branch", "list"]);
      yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })([
        "db",
        "remote",
        "changes",
      ]);

      expect(proxy.calls).toEqual([
        ["db", "branch", "list"],
        ["db", "remote", "changes"],
      ]);
    }).pipe(Effect.provide(hiddenCommandLayer(proxy.layer, false)));
  });

  it.effect("still executes the native `db test` hidden alias by exact name (CLI-1962)", () => {
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
    const layer = hiddenCommandLayer(proxy.layer, false);

    return Effect.gen(function* () {
      const dbTestExit = yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })([
        "db",
        "test",
      ]).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(dbTestExit)).toBe(true);
      if (Exit.isFailure(dbTestExit)) {
        // A typed native-handler failure still proves dispatch reached `db test`;
        // the exact operational failure depends on the injected local runtime.
        expect(encodeJsonText(dbTestExit)).not.toContain("UnknownSubcommand");
      }

      const unknownExit = yield* Command.runWith(legacyTestRoot, {
        version: "0.0.0-test",
      })(["db", "not-a-real-command"]).pipe(Effect.provide(layer), Effect.exit);
      // Effect CLI's raw `_tag` uses the corrected "UnknownSubcommand" spelling.
      // This assertion checks the raw, un-normalized tag so it stays aligned with
      // the upstream parser error value.
      expect(encodeJsonText(unknownExit)).toContain("UnknownSubcommand");
      expect(Exit.isFailure(unknownExit)).toBe(true);
      if (Exit.isFailure(unknownExit)) {
        expect(unknownExit.cause.reasons.some(Cause.isFailReason)).toBe(true);
      }
    }).pipe(Effect.provide(layer));
  });
});
