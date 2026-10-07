import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { CliOutput, Command } from "effect/unstable/cli";
import { Effect, Layer, Option, Redacted, Schema, Stream } from "effect";
import type {
  Observation,
  SavedStack,
  ServiceCreation,
  Stack,
  StackCredentials,
} from "@supabase/stack/effect";
import {
  mockAnalytics,
  mockOutput,
  mockProcessControl,
  mockStdin,
  mockRuntimeInfo,
  mockTelemetryRuntime,
  mockTty,
} from "../../../../../tests/helpers/mocks.ts";
import { mockTelemetryStateTracked } from "../../../../../tests/helpers/command-mocks.ts";
import { unusedGateway } from "../../../../../tests/helpers/unused-stack.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { textCliOutputFormatter } from "../../../../shared/output/text-formatter.ts";
import { GLOBAL_FLAGS, WorkdirFlag } from "../../../../command-internal/global-flags.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { StackApi, StackTargetResolver } from "../stack.shared.ts";
import { stackStatusCommand } from "../status/status.command.ts";
import { statusEnvPointer } from "./start-summary.format.ts";

/** Distinguishable credentials, keyed by a short tag, for one fake target stack. */
const credentialsFor = (tag: string): StackCredentials => ({
  jwtSecret: `${tag}-secret`.padEnd(32, "0"),
  postgresRootKey: `root-key-${tag}`,
  databasePassword: `password-${tag}`,
  publishableKey: `sb_publishable_${tag}`,
  secretKey: `sb_secret_${tag}`,
  anonKey: `anon-${tag}`,
  serviceRoleKey: `service-${tag}`,
  jwks: "{}",
  gotrueJwtKeys: "[]",
  remoteJwks: "[]",
  anonKeyIsOverride: false,
  serviceRoleKeyIsOverride: false,
});

const databaseCreation = (sqlPort: number, credentials: StackCredentials): ServiceCreation => ({
  service: "database",
  config: {
    version: "17",
    databasePassword: Redacted.make(credentials.databasePassword),
    jwtSecret: Redacted.make(credentials.jwtSecret),
    jwtExpiry: 3600,
  },
  endpoints: { sql: { port: sqlPort } },
});

/** A running, credentialed single-database stack distinguishable by its saved sql port. */
function makeDatabaseStack(sqlPort: number, credentials: StackCredentials): Stack {
  const creation = databaseCreation(sqlPort, credentials);
  const observation: Observation = {
    id: "database-id",
    endpoints: [{ name: "sql", protocol: "tcp", host: "127.0.0.1", port: sqlPort }],
    config: creation,
    lifecycle: "running",
    health: "healthy",
    error: undefined,
    cleanupError: undefined,
    exit: undefined,
    currentOperation: undefined,
    launchId: undefined,
    intentRevision: 1,
    wakeEnabled: false,
    registered: true,
  };
  const databaseInstance = {
    id: "database-id",
    service: "database" as const,
    start: Effect.die("unused"),
    ready: Effect.die("unused"),
    stop: Effect.die("unused"),
    restart: () => Effect.die("unused"),
    destroy: Effect.die("unused"),
    prepare: Effect.die("unused"),
    status: Effect.succeed(observation),
    followStatus: Stream.empty,
    readLogs: () => Stream.empty,
    credentials: () => Effect.succeed({}),
    saveSnapshot: () => Effect.die("unused"),
    restoreSnapshot: () => Effect.die("unused"),
    resetData: Effect.die("unused"),
  };
  return {
    id: `stack-${sqlPort}`,
    services: {
      create: () => Effect.die("unused"),
      get: () => Effect.succeed(databaseInstance),
      list: Effect.succeed([databaseInstance]),
    },
    credentials: { get: Effect.succeed(credentials) },
    composition: {
      plan: () => Effect.die("unused"),
      supabase: () => Effect.die("unused"),
      configure: () => Effect.die("unused"),
      describe: Effect.succeed({
        members: [{ id: "database-id", activation: "eager" as const }],
        dependencies: [],
      }),
      start: Effect.die("unused"),
      stop: Effect.die("unused"),
      restart: Effect.die("unused"),
    },
    stop: Effect.die("unused"),
    destroy: Effect.die("unused"),
    gateway: unusedGateway,
    commands: { run: () => Effect.die("unused") },
  } satisfies Stack;
}

const definitionFor = (id: string, projectRoot: string, creation: ServiceCreation): SavedStack => ({
  id,
  lifetime: "detached",
  identity: { projectRoot, branchContext: "pointer-test", stackName: id },
  runtime: "native",
  instances: [{ id: "database-id", creation }],
  composition: { members: [{ id: "database-id", activation: "eager" }], dependencies: [] },
  ports: [],
});

interface TargetSpec {
  readonly projectRoot: string;
  readonly name?: string;
  readonly sqlPort: number;
  readonly tag: string;
}

/** The fake resolver's key, matching the real resolver's `(projectRoot, name)` lookup. */
const targetKey = (projectRoot: string, name: string | undefined) =>
  `${projectRoot}\u0000${name ?? ""}`;

/**
 * Runs `stackStatusCommand` with the given literal argv (excluding the `supabase` program
 * name) against a fake resolver stocked with `specs`, so a `--stack` that failed to reach the
 * resolver resolves the project's default stack instead of the intended one — a distinguishable
 * failure rather than a silent pass.
 */
const runStatusEnv = (input: {
  readonly argv: ReadonlyArray<string>;
  readonly ambientCwd: string;
  readonly specs: ReadonlyArray<TargetSpec>;
}) =>
  Effect.gen(function* () {
    const targets = new Map<string, { readonly id: string; readonly definition: SavedStack }>();
    const stacksById = new Map<string, Stack>();
    for (const spec of input.specs) {
      const credentials = credentialsFor(spec.tag);
      const stack = makeDatabaseStack(spec.sqlPort, credentials);
      targets.set(targetKey(spec.projectRoot, spec.name), {
        id: stack.id,
        definition: definitionFor(
          stack.id,
          spec.projectRoot,
          databaseCreation(spec.sqlPort, credentials),
        ),
      });
      stacksById.set(stack.id, stack);
    }

    const resolver = Layer.succeed(StackTargetResolver, {
      resolve: (resolveInput) =>
        Effect.sync(() => {
          const target = targets.get(targetKey(resolveInput.projectRoot, resolveInput.name));
          return {
            projectRoot: resolveInput.projectRoot,
            ...(target === undefined ? {} : { id: target.id, definition: target.definition }),
            hostRunning: target !== undefined,
          };
        }),
    });
    const api = Layer.succeed(StackApi, {
      create: () => Effect.die("unused"),
      open: ({ id }) => {
        const stack = stacksById.get(id);
        return stack === undefined ? Effect.die(`unknown stack ${id}`) : Effect.succeed(stack);
      },
      discover: () => Effect.die("unused"),
      find: () => Effect.die("unused"),
      findDeleted: () => Effect.die("unused"),
    });
    // Only `--workdir` selects the project here; an absent flag falls back to the ambient cwd,
    // which is registered under its own distinguishable stack so a dropped `--workdir` fails
    // the test's assertions instead of passing unnoticed.
    const commandSettings = Layer.effect(
      CommandSettings,
      Effect.gen(function* () {
        const workdirFlag = yield* WorkdirFlag;
        const workdir = Option.getOrElse(workdirFlag, () => input.ambientCwd);
        return CommandSettings.of({
          profile: "supabase",
          profileEnvValue: Option.none(),
          supabaseHome: "/pointer-test/.supabase",
          apiUrl: "https://api.supabase.com",
          projectHost: "supabase.co",
          poolerHost: "supabase.com",
          dashboardUrl: "https://supabase.com/dashboard",
          accessToken: Option.none(),
          dbPassword: Option.none(),
          githubToken: Option.none(),
          projectId: Option.none(),
          workdir,
          explicitWorkdir: Option.isSome(workdirFlag),
          workdirEnvValue: Option.none(),
          userAgent: "SupabaseCLI/pointer-test",
        });
      }),
    );

    const output = mockOutput({ format: "json" });
    const analytics = mockAnalytics();
    const telemetry = mockTelemetryStateTracked();
    // `Command.provide` (not `Effect.provide` on the whole run) so `commandSettings`'s
    // `WorkdirFlag` read resolves against this command node's own parsed flags, the same
    // timing the production `stackRuntimeLayer` composition relies on.
    const command = stackStatusCommand.pipe(
      Command.provide(commandRuntimeLayer(["status"])),
      Command.provide(Layer.mergeAll(resolver, api, commandSettings, telemetry.layer)),
    );
    const testRoot = Command.make("supabase").pipe(
      Command.withSubcommands([command]),
      Command.withGlobalFlags(GLOBAL_FLAGS),
    );

    yield* Command.runWith(testRoot, { version: "0.0.0-test" })(input.argv).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          CliOutput.layer(textCliOutputFormatter()),
          output.layer,
          analytics.layer,
          mockProcessControl().layer,
          Layer.succeed(CliArgs, { args: input.argv }),
          mockTty({ stdinIsTty: false, stdoutIsTty: false }),
          mockStdin(false),
          mockRuntimeInfo({ cwd: input.ambientCwd, homeDir: "/pointer-test/home" }),
          mockTelemetryRuntime({ configDir: "/pointer-test/.supabase" }),
        ),
      ),
    );

    return yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
    )(output.rawChunks.map(({ text }) => text).join(""));
  }).pipe(Effect.provide(BunServices.layer));

describe("stack start export pointer", () => {
  it.live(
    "the printed pointer's argv resolves --workdir and the named --stack to that stack, not the caller's cwd or the project's default stack",
    () =>
      Effect.gen(function* () {
        const projectRoot = "/pointer-test/project";
        const ambientCwd = "/pointer-test/project-b";
        const values = yield* runStatusEnv({
          argv: ["status", "--env", "--workdir", projectRoot, "--stack", "docker"],
          ambientCwd,
          specs: [
            { projectRoot, sqlPort: 40001, tag: "default" },
            { projectRoot, name: "docker", sqlPort: 40002, tag: "named" },
            { projectRoot: ambientCwd, sqlPort: 40003, tag: "cwd" },
          ],
        });
        expect(values.DB_URL).toContain(":40002/");
        expect(values.PUBLISHABLE_KEY).toBe("sb_publishable_named");

        // Pass `"posix"` explicitly so this assertion doesn't depend on the host running the
        // test; `currentShellPlatform()` would render PowerShell quoting on win32.
        const pointer = statusEnvPointer(
          { explicitWorkdir: true, projectRoot, stack: "docker" },
          "posix",
        );
        expect(pointer).toBe(`supabase status --env --workdir ${projectRoot} --stack docker`);
      }),
  );

  it.live(
    "quotes a workdir and stack name that need it, and the same raw values still resolve that stack",
    () =>
      Effect.gen(function* () {
        const projectRoot = "/pointer-test/project with space";
        const stackName = "feature one's box";
        const ambientCwd = "/pointer-test/project-b";
        const values = yield* runStatusEnv({
          argv: ["status", "--env", "--workdir", projectRoot, "--stack", stackName],
          ambientCwd,
          specs: [
            { projectRoot, sqlPort: 40004, tag: "default" },
            { projectRoot, name: stackName, sqlPort: 40005, tag: "named" },
          ],
        });
        expect(values.DB_URL).toContain(":40005/");
        expect(values.PUBLISHABLE_KEY).toBe("sb_publishable_named");

        const pointer = statusEnvPointer(
          { explicitWorkdir: true, projectRoot, stack: stackName },
          "posix",
        );
        expect(pointer).toBe(
          `supabase status --env --workdir '${projectRoot}' --stack 'feature one'"'"'s box'`,
        );
      }),
  );
});
