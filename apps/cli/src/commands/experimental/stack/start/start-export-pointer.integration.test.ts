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
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { textCliOutputFormatter } from "../../../../shared/output/text-formatter.ts";
import { GLOBAL_FLAGS, WorkdirFlag } from "../../../../command-internal/global-flags.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { StackApi, StackTargetResolver } from "../stack.shared.ts";
import { stackStatusCommand } from "../status/status.command.ts";
import { statusEnvPointer } from "./start-summary.format.ts";

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
    logs: Stream.empty,
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

/**
 * Runs the `start`-printed `status --env` pointer for `projectA` (with an optional `--stack`
 * name) through the real command grammar, with `projectB` standing in for the caller's cwd, and
 * returns the decoded `--env` JSON so callers can assert which stack actually resolved.
 */
const runPointer = (input: {
  readonly projectA: string;
  readonly projectB: string;
  readonly stack?: string;
}) =>
  Effect.gen(function* () {
    const credentialsA: StackCredentials = {
      jwtSecret: "a".repeat(32),
      postgresRootKey: "root-key-a",
      databasePassword: "password-a",
      publishableKey: "sb_publishable_a",
      secretKey: "sb_secret_a",
      anonKey: "anon-a",
      serviceRoleKey: "service-a",
      jwks: "{}",
      gotrueJwtKeys: "[]",
      remoteJwks: "[]",
      anonKeyIsOverride: false,
      serviceRoleKeyIsOverride: false,
    };
    const credentialsB: StackCredentials = {
      jwtSecret: "b".repeat(32),
      postgresRootKey: "root-key-b",
      databasePassword: "password-b",
      publishableKey: "sb_publishable_b",
      secretKey: "sb_secret_b",
      anonKey: "anon-b",
      serviceRoleKey: "service-b",
      jwks: "{}",
      gotrueJwtKeys: "[]",
      remoteJwks: "[]",
      anonKeyIsOverride: false,
      serviceRoleKeyIsOverride: false,
    };
    const stackA = makeDatabaseStack(40001, credentialsA);
    const stackB = makeDatabaseStack(40002, credentialsB);
    const targets = new Map([
      [
        input.projectA,
        {
          id: stackA.id,
          definition: definitionFor(
            stackA.id,
            input.projectA,
            databaseCreation(40001, credentialsA),
          ),
        },
      ],
      [
        input.projectB,
        {
          id: stackB.id,
          definition: definitionFor(
            stackB.id,
            input.projectB,
            databaseCreation(40002, credentialsB),
          ),
        },
      ],
    ]);
    const stacksById = new Map([
      [stackA.id, stackA],
      [stackB.id, stackB],
    ]);

    const resolver = Layer.succeed(StackTargetResolver, {
      resolve: (resolveInput) =>
        Effect.sync(() => {
          const target = targets.get(resolveInput.projectRoot);
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
    });
    // Only `--workdir` selects the project here; an absent flag falls back to `projectB`, so
    // a pointer that fails to carry `--workdir` through would resolve the wrong stack.
    const commandSettings = Layer.effect(
      CommandSettings,
      Effect.gen(function* () {
        const workdirFlag = yield* WorkdirFlag;
        const workdir = Option.getOrElse(workdirFlag, () => input.projectB);
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

    // The exact string `start` prints for this stack's selection, in the format tokenizePointer
    // below reverses.
    const pointer = statusEnvPointer({
      explicitWorkdir: true,
      projectRoot: input.projectA,
      ...(input.stack === undefined ? {} : { stack: input.stack }),
    });
    const [programName, ...args] = tokenizePointer(pointer);
    expect(programName).toBe("supabase");

    yield* Command.runWith(testRoot, { version: "0.0.0-test" })(args).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          CliOutput.layer(textCliOutputFormatter()),
          output.layer,
          analytics.layer,
          mockProcessControl().layer,
          Layer.succeed(CliArgs, { args }),
          mockTty({ stdinIsTty: false, stdoutIsTty: false }),
          mockStdin(false),
          mockRuntimeInfo({ cwd: input.projectB, homeDir: "/pointer-test/home" }),
          mockTelemetryRuntime({
            configDir: "/pointer-test/.supabase",
            tracesDir: "/pointer-test/.supabase/traces",
          }),
        ),
      ),
    );

    const values = yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
    )(output.rawChunks.map(({ text }) => text).join(""));
    return { pointer, values };
  }).pipe(Effect.provide(BunServices.layer));

/**
 * Reverses `shellQuoteArgument`'s exact POSIX quoting — not a general shell parser — so this
 * test exercises the literal string `start` prints, the same bytes a user would paste. A bare
 * argument is unquoted; a quoted one wraps in `'...'`, with an embedded `'` written as the
 * adjoining segments `'` `"'"` `'` (close single-quote, a double-quoted literal `'`, reopen).
 * Adjoining quoted/unquoted segments with no space between them form one shell word, so this
 * only needs to track which quote (if any) is currently open and split on unquoted spaces.
 */
function tokenizePointer(command: string): ReadonlyArray<string> {
  const tokens: Array<string> = [];
  let i = 0;
  while (i < command.length) {
    while (command[i] === " ") i++;
    if (i >= command.length) break;
    let token = "";
    let quote: "'" | '"' | undefined;
    while (i < command.length && (quote !== undefined || command[i] !== " ")) {
      const char = command[i];
      if (quote === undefined && (char === "'" || char === '"')) quote = char;
      else if (char === quote) quote = undefined;
      else token += char;
      i++;
    }
    tokens.push(token);
  }
  return tokens;
}

describe("stack start export pointer", () => {
  it.live(
    "the printed `status --env` pointer parses through the real command grammar and resolves the --workdir project, not the caller's cwd",
    () =>
      Effect.gen(function* () {
        // Two distinct projects: the pointer explicitly names `projectA`, while the ambient
        // "current directory" (the fallback when no --workdir is given) is `projectB`. A correct
        // parse and resolution must reach A's stack; a wrong argv order either fails to parse or
        // silently resolves B.
        // `--stack` is a flag of the `status` subcommand itself (unlike `--workdir`, a real
        // global flag), so it only proves the fix if it appears after the subcommand keyword.
        const { pointer, values } = yield* runPointer({
          projectA: "/pointer-test/project-a",
          projectB: "/pointer-test/project-b",
          stack: "docker",
        });
        expect(pointer).toBe(
          "supabase status --env --workdir /pointer-test/project-a --stack docker",
        );
        expect(values.DB_URL).toContain(":40001/");
        expect(values.DB_URL).not.toContain(":40002/");
        expect(values.PUBLISHABLE_KEY).toBe("sb_publishable_a");
      }),
  );

  it.live(
    "quotes a workdir and stack name that need it, and both still round-trip to the same stack",
    () =>
      Effect.gen(function* () {
        const projectA = "/pointer-test/project with space";
        const { pointer, values } = yield* runPointer({
          projectA,
          projectB: "/pointer-test/project-b",
          stack: "feature one's box",
        });
        expect(pointer).toBe(
          `supabase status --env --workdir '/pointer-test/project with space' --stack 'feature one'"'"'s box'`,
        );
        expect(values.DB_URL).toContain(":40001/");
        expect(values.DB_URL).not.toContain(":40002/");
        expect(values.PUBLISHABLE_KEY).toBe("sb_publishable_a");
      }),
  );
});
