import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { parse as parseDotenv } from "dotenv";
import {
  Cause,
  Effect,
  FileSystem,
  Exit,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import {
  InvalidStackConfigError,
  StackNotFoundError,
  StackNotRunningError,
  StackIdSchema,
  StackStateFormatUnsupportedError,
  type EffectStack,
  type StackInspection,
  type StackStatus,
} from "@supabase/stack/effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import { GLOBAL_OUTPUT_FORMATS, OutputFlag } from "../../../../command-internal/global-flags.ts";
import {
  actionability,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";
import { StackApi } from "../stack.shared.ts";
import { stackStatus } from "./status.handler.ts";
import { stackStatusCommand } from "./status.command.ts";
import { textCliOutputFormatter } from "../../../../shared/output/text-formatter.ts";

const id = StackIdSchema.make("a".repeat(64));
const capabilityNames = [
  "database",
  "rest",
  "auth",
  "realtime",
  "storage",
  "functions",
  "studio",
  "mail",
  "analytics",
  "pooler",
] as const;
const flags = (stack = Option.none<string>(), stackId = Option.none<string>()) => ({
  stack,
  stackId,
  env: false,
  overrideName: [] as string[],
});

const makeStatus = (
  stackId: typeof id,
  desiredLifecycle: StackStatus["desiredLifecycle"] = "running",
): StackStatus => ({
  id: stackId,
  lifecycle: "running",
  desiredLifecycle,
  runtime: { kind: "native" },
  endpoints: {
    api: { protocol: "http", address: "127.0.0.1", port: 54321, url: "http://127.0.0.1:54321" },
  },
  versions: {},
  capabilities: capabilityNames.map((name) => ({
    name,
    activation: "lazy" as const,
    state: "dormant" as const,
  })),
  artifacts: [],
});

const runStatus = (options: {
  readonly config?: "valid" | "missing" | "invalid";
  readonly owner?: StackInspection["owner"];
  readonly status?: StackStatus;
  readonly drift?: StackInspection["configDrift"];
  readonly flags?: ReturnType<typeof flags>;
  readonly compareFailure?: "typed" | "defect";
  readonly missingTarget?: boolean;
  readonly legacyOutput?: (typeof GLOBAL_OUTPUT_FORMATS)[number];
  readonly outputFormat?: "text" | "json" | "stream-json";
  readonly credentialFailure?: boolean;
  readonly storageCredentials?: boolean;
  readonly authDisabled?: boolean;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-status-" });
    const projectRoot = path.join(root, "project");
    yield* fs.makeDirectory(path.join(projectRoot, "supabase"), { recursive: true });
    if (options.config !== "missing")
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", "config.toml"),
        options.config === "invalid"
          ? 'project_id = "ok"\n\n[auth]\njwt_secret = "FAKE_STATUS_SECRET\n'
          : 'project_id = "status-test"\n\n[auth]\njwt_secret = "candidate-secret"\n',
      );
    const descriptor = {
      id,
      projectRoot,
      name: "feature-a",
      branchContext: "ordinary-workspace",
      runtime: { kind: "native" as const },
      desiredLifecycle: "running" as const,
    };
    const inspection: StackInspection = {
      descriptor,
      owner: options.owner ?? "running",
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.drift === undefined ? {} : { configDrift: options.drift }),
    };
    const out = mockOutput({ format: options.outputFormat ?? "text" });
    const telemetry = mockTelemetryStateTracked();
    const findInputs: unknown[] = [];
    const inspectInputs: unknown[] = [];
    const api = Layer.succeed(StackApi, {
      createStack: () => Effect.die("create must not run"),
      discoverStacks: () => Effect.succeed({ stacks: [], errors: [] }),
      findStack: (input) => {
        findInputs.push(input);
        return Effect.succeed(options.missingTarget ? Option.none() : Option.some(descriptor));
      },
      openStack: (openId) =>
        Effect.succeed({
          id: openId,
          status: Effect.succeed(options.status ?? makeStatus(id)),
          credentials:
            options.credentialFailure === true
              ? Effect.fail(
                  new StackNotRunningError({ stackId: id, message: "Stack is not running" }),
                )
              : Effect.succeed({
                  database: {
                    url: Redacted.make("postgresql://postgres:p%40ss@127.0.0.1:54322/postgres"),
                    password: Redacted.make("p@ss"),
                  },
                  ...(options.authDisabled === true
                    ? {}
                    : {
                        api: {
                          anonJwt: "anon-token",
                          serviceRoleJwt: Redacted.make("service-role-token"),
                          publishableKey: "sb_publishable_test",
                          secretKey: Redacted.make("sb_secret_test"),
                        },
                      }),
                  ...(options.storageCredentials === true
                    ? {
                        storage: {
                          endpoint: "http://127.0.0.1:54321/storage/v1/s3",
                          region: "local",
                          accessKeyId: "storage-access",
                          secretAccessKey: Redacted.make("storage-secret"),
                        },
                      }
                    : {}),
                }),
          prepare: () => Effect.die("unused"),
          start: () => Effect.die("unused"),
          stop: Effect.die("unused"),
          destroy: Effect.die("unused"),
          resetDatabase: Effect.die("unused"),
          logs: () => Effect.die("unused"),
          followLogs: () => Stream.empty,
        } satisfies EffectStack),
      inspectStack: (_stackId, inspectOptions) => {
        inspectInputs.push(inspectOptions);
        if (options.missingTarget === true)
          return Effect.fail(new StackNotFoundError({ message: "stack id not found" }));
        if (inspectOptions?.config !== undefined && options.compareFailure === "typed")
          return Effect.fail(
            new InvalidStackConfigError({ message: "candidate config is invalid" }),
          );
        if (inspectOptions?.config !== undefined && options.compareFailure === "defect")
          return Effect.die("comparison defect");
        return Effect.succeed(inspection);
      },
    });
    const layer = Layer.mergeAll(
      out.layer,
      telemetry.layer,
      api,
      mockCommandSettings({ workdir: root }),
      ...(options.legacyOutput === undefined
        ? []
        : [Layer.succeed(OutputFlag, Option.some(options.legacyOutput))]),
      BunServices.layer,
    );
    const effect = stackStatus(options.flags ?? flags()).pipe(Effect.provide(layer));
    return { effect, out, findInputs, inspectInputs, projectRoot, root };
  }).pipe(Effect.provide(BunServices.layer));

const withRunStatus = <A, E>(
  options: Parameters<typeof runStatus>[0],
  test: (run: Effect.Success<ReturnType<typeof runStatus>>) => Effect.Effect<A, E>,
) => runStatus(options).pipe(Effect.flatMap(test));

describe("stack status", () => {
  it.effect(
    "reports configured identity, dormant readiness, endpoint, drift, and target config",
    () => {
      return withRunStatus(
        {
          status: makeStatus(id),
          drift: { status: "changed", paths: ["definition.listeners.api.port"] },
        },
        (run) =>
          run.effect.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                expect(run.findInputs).toEqual([{ projectRoot: expect.any(String) }]);
                expect(run.inspectInputs).toHaveLength(1);
                expect(run.inspectInputs[0]).toEqual({ config: expect.any(Object) });
                expect(run.out.stdoutText).toContain("Runtime: native");
                expect(run.out.stdoutText).toContain("Readiness: dormant");
                expect(run.out.stdoutText).toContain("http://127.0.0.1:54321");
                expect(run.out.stdoutText).toContain("definition.listeners.api.port");
                expect(run.out.stdoutText).not.toContain("candidate-secret");
              }),
            ),
          ),
      );
    },
  );

  it.effect("forwards a named stack target with the settings project root", () => {
    return withRunStatus(
      { flags: flags(Option.some("feature-a")), status: makeStatus(id) },
      (run) =>
        run.effect.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              expect(run.findInputs).toEqual([{ projectRoot: run.root, name: "feature-a" }]);
            }),
          ),
        ),
    );
  });

  it.effect("uses the persisted project root for an explicit id from another cwd", () => {
    return withRunStatus(
      { flags: flags(Option.none(), Option.some(id)), status: makeStatus(id) },
      (run) =>
        run.effect.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              expect(run.inspectInputs).toHaveLength(2);
              expect(run.inspectInputs[1]).toEqual({ config: expect.any(Object) });
            }),
          ),
        ),
    );
  });

  it.effect("reuses the explicit id inspection when config is invalid", () => {
    return withRunStatus(
      {
        config: "invalid",
        flags: flags(Option.none(), Option.some(id)),
        status: makeStatus(id),
      },
      (run) =>
        run.effect.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              expect(run.inspectInputs).toHaveLength(1);
              expect(run.inspectInputs[0]).toBeUndefined();
            }),
          ),
        ),
    );
  });

  it.effect("compares an absent config.toml against default settings like stack start", () => {
    return withRunStatus(
      {
        config: "missing",
        flags: flags(Option.none(), Option.some(id)),
        status: makeStatus(id),
        drift: { status: "unchanged", paths: [] },
      },
      (run) =>
        run.effect.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              expect(run.inspectInputs).toHaveLength(2);
              expect(run.inspectInputs[1]).toEqual({ config: expect.any(Object) });
              expect(run.out.stdoutText).toContain("Config drift: unchanged");
              expect(run.out.stdoutText).not.toContain("Config warning");
            }),
          ),
        ),
    );
  });

  it.effect("reports stopped and unreachable stacks without claiming live readiness", () => {
    return withRunStatus({ owner: "absent" }, (run) =>
      run.effect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(run.out.stdoutText).toContain("Lifecycle: unavailable");
            expect(run.out.stdoutText).toContain("Desired lifecycle: running");
            expect(run.out.stdoutText).toContain("Readiness: unknown");
          }),
        ),
      ),
    );
  });

  it.effect("does not claim ready when a running stack has stopped capabilities", () => {
    const base = makeStatus(id);
    return withRunStatus(
      {
        status: {
          ...base,
          capabilities: base.capabilities.map((capability, index) =>
            index === 0 ? { ...capability, state: "stopped" as const } : capability,
          ),
        },
      },
      (run) =>
        run.effect.pipe(
          Effect.tap(() =>
            Effect.sync(() => expect(run.out.stdoutText).toContain("Readiness: stopped")),
          ),
        ),
    );
  });

  it.effect("reports a retiring capability as stopping in text and JSON", () => {
    const base = makeStatus(id);
    const status = {
      ...base,
      capabilities: base.capabilities.map((capability) =>
        capability.name === "rest" ? { ...capability, state: "stopping" as const } : capability,
      ),
    };
    return Effect.all([runStatus({ status }), runStatus({ status, outputFormat: "json" })]).pipe(
      Effect.flatMap(([text, json]) =>
        Effect.all([text.effect, json.effect]).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              expect(text.out.stdoutText).toContain("Readiness: stopping");
              const success = json.out.messages.find((message) => message.type === "success");
              expect(success?.data).toMatchObject({ readiness: "stopping" });
            }),
          ),
        ),
      ),
    );
  });

  it.effect("reports failed capability diagnostics and targeted recovery in text and JSON", () => {
    const base = makeStatus(id);
    const status: StackStatus = {
      ...base,
      capabilities: base.capabilities.map((capability) =>
        capability.name === "rest"
          ? {
              ...capability,
              state: "failed" as const,
              error: "Unable to remove REST workload",
            }
          : capability,
      ),
      recovery: {
        operation: "stop",
        message: "Cleanup is incomplete; stop and start the stack to retry it.",
      },
    };
    return Effect.all([runStatus({ status }), runStatus({ status, outputFormat: "json" })]).pipe(
      Effect.flatMap(([text, json]) =>
        Effect.all([text.effect, json.effect]).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              expect(text.out.stdoutText).toContain(
                "rest: failed — Unable to remove REST workload",
              );
              expect(text.out.stdoutText).toContain(
                `supabase stack stop --stack-id ${id} && supabase stack start --stack-id ${id}`,
              );
              const success = json.out.messages.find((message) => message.type === "success");
              expect(success?.data).toMatchObject({ recovery: status.recovery });
              expect(success?.data).toMatchObject({
                capabilities: expect.arrayContaining([
                  expect.objectContaining({
                    name: "rest",
                    state: "failed",
                    error: "Unable to remove REST workload",
                  }),
                ]),
              });
            }),
          ),
        ),
      ),
    );
  });

  it.effect("emits the structured unavailable inspection for invalid config", () => {
    return withRunStatus(
      {
        config: "invalid",
        flags: flags(Option.none(), Option.some(id)),
        outputFormat: "json",
      },
      (run) =>
        run.effect.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              expect(run.out.stdoutText).toBe("");
              const success = run.out.messages.find((message) => message.type === "success");
              expect(success?.data).toMatchObject({
                identity: {
                  id,
                  name: "feature-a",
                  project_root: run.projectRoot,
                  branch_context: "ordinary-workspace",
                },
                owner: "running",
                readiness: "unknown",
                lifecycle: null,
                desired_lifecycle: "running",
                config_drift: {
                  status: "unavailable",
                  message:
                    "Project configuration could not be loaded; fix it before checking drift.",
                },
              });
            }),
          ),
        ),
    );
  });

  it.effect("uses the live desired lifecycle consistently in text and JSON", () => {
    return Effect.all([
      runStatus({ status: makeStatus(id, "stopped") }),
      runStatus({ status: makeStatus(id, "stopped"), outputFormat: "json" }),
    ]).pipe(
      Effect.flatMap(([text, json]) =>
        Effect.all([text.effect, json.effect]).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              expect(text.out.stdoutText).toContain("Desired lifecycle: stopped");
              const success = json.out.messages.find((message) => message.type === "success");
              expect(success?.data).toMatchObject({ desired_lifecycle: "stopped" });
            }),
          ),
        ),
      ),
    );
  });

  it.effect("reports unavailable drift for invalid config and keeps inspection", () => {
    return Effect.all([
      runStatus({ config: "invalid", status: makeStatus(id) }),
      runStatus({
        config: "invalid",
        status: makeStatus(id),
        outputFormat: "json",
      }),
    ]).pipe(
      Effect.flatMap(([invalid, invalidJson]) =>
        Effect.all([invalid.effect, invalidJson.effect]).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              expect(invalid.out.stdoutText).toContain("Config drift: unavailable");
              expect(invalid.out.stdoutText).not.toContain("FAKE_STATUS_SECRET");
              const success = invalidJson.out.messages.find(
                (message) => message.type === "success",
              );
              expect(success?.data).toMatchObject({
                config_drift: {
                  status: "unavailable",
                  message:
                    "Project configuration could not be loaded; fix it before checking drift.",
                },
              });
              // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- JSON.stringify checks all fields for leaked secrets; schema encoding could omit unexpected fields
              expect(JSON.stringify(success?.data)).not.toContain("FAKE_STATUS_SECRET");
            }),
          ),
        ),
      ),
    );
  });

  it.effect("points an empty current context to the start command", () => {
    return withRunStatus({ missingTarget: true }, (run) =>
      run.effect.pipe(
        Effect.flip,
        Effect.tap((error) =>
          Effect.sync(() => {
            expect(error.suggestion).toBe("Run supabase stack start first.");
            expect(run.inspectInputs).toEqual([]);
          }),
        ),
      ),
    );
  });

  it.effect("gives actionable guidance when an explicit stack id is missing", () => {
    return withRunStatus(
      {
        flags: flags(Option.none(), Option.some(id)),
        missingTarget: true,
      },
      (run) =>
        run.effect.pipe(
          Effect.exit,
          Effect.tap((exit) =>
            Effect.sync(() => {
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                const error = Cause.findErrorOption(exit.cause);
                expect(Option.isSome(error)).toBe(true);
                if (Option.isSome(error)) {
                  expect(error.value.suggestion).toContain("existing --stack-id");
                  expect(error.value[ErrorActionabilityId]).toEqual(actionability.provideFlags);
                }
              }
            }),
          ),
        ),
    );
  });

  it.effect("falls back only for typed comparison errors and preserves defects", () => {
    return Effect.all([
      runStatus({ compareFailure: "typed", status: makeStatus(id) }),
      runStatus({
        compareFailure: "typed",
        status: makeStatus(id),
        outputFormat: "json",
      }),
      runStatus({ compareFailure: "defect", status: makeStatus(id) }),
    ]).pipe(
      Effect.flatMap(([typed, typedJson, defect]) =>
        Effect.gen(function* () {
          yield* typed.effect;
          expect(typed.inspectInputs).toHaveLength(2);
          expect(typed.out.stdoutText).toContain("Config drift: unavailable");
          expect(typed.out.stdoutText).toContain(
            "Config warning: Project configuration could not be compared: candidate config is invalid",
          );
          yield* typedJson.effect;
          const success = typedJson.out.messages.find((message) => message.type === "success");
          expect(success?.data).toMatchObject({
            config_drift: {
              status: "unavailable",
              message: "Project configuration could not be compared: candidate config is invalid",
            },
          });
          const exit = yield* defect.effect.pipe(Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          expect(defect.inspectInputs).toHaveLength(1);
        }),
      ),
    );
  });

  it.effect("rejects invalid flags and legacy output before discovery", () => {
    return Effect.all([
      runStatus({ flags: flags(Option.some("feature-a"), Option.some(id)) }),
      runStatus({ legacyOutput: "json" }),
    ]).pipe(
      Effect.flatMap(([invalid, legacy]) =>
        Effect.gen(function* () {
          expect(Exit.isFailure(yield* invalid.effect.pipe(Effect.exit))).toBe(true);
          expect(Exit.isFailure(yield* legacy.effect.pipe(Effect.exit))).toBe(true);
          expect(invalid.findInputs).toHaveLength(0);
          expect(legacy.findInputs).toHaveLength(0);
        }),
      ),
    );
  });

  it.effect("rejects the legacy -o env form with a pointer to --env", () => {
    return withRunStatus({ legacyOutput: "env" }, (run) =>
      run.effect.pipe(
        Effect.flip,
        Effect.tap((error) =>
          Effect.sync(() => {
            expect(error.suggestion).toContain("--env");
            expect(run.findInputs).toHaveLength(0);
          }),
        ),
      ),
    );
  });

  it.effect("does not retry discovery failures", () => {
    return withRunStatus({}, (run) => {
      const telemetry = mockTelemetryStateTracked();
      const discovery = Layer.succeed(StackApi, {
        createStack: () => Effect.die("create must not run"),
        discoverStacks: () => Effect.succeed({ stacks: [], errors: [] }),
        findStack: () =>
          Effect.fail(new StackStateFormatUnsupportedError({ message: "discovery failed" })),
        openStack: () => Effect.die("open must not run"),
        inspectStack: () => Effect.die("inspect must not run"),
      });
      const effect = stackStatus(flags()).pipe(
        Effect.provide(
          Layer.mergeAll(
            run.out.layer,
            telemetry.layer,
            discovery,
            mockCommandSettings({ workdir: run.projectRoot }),
            BunServices.layer,
          ),
        ),
        Effect.exit,
      );
      return effect.pipe(
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              const error = Cause.findErrorOption(exit.cause);
              expect(Option.isSome(error)).toBe(true);
              if (Option.isSome(error))
                expect(error.value[ErrorActionabilityId]).toEqual(actionability.invalidConfig);
            }
          }),
        ),
      );
    });
  });

  it.live("parses stack name and stack id through the command", () => {
    let parsed: { stack: Option.Option<string>; stackId: Option.Option<string> } | undefined;
    const command = stackStatusCommand.pipe(
      Command.withHandler((parsedFlags) =>
        Effect.sync(() => {
          parsed = { stack: parsedFlags.stack, stackId: parsedFlags.stackId };
        }),
      ),
    );
    return Effect.gen(function* () {
      yield* Command.runWith(command, { version: "0.0.0-test" })(["--stack", "feature-a"]);
      expect(parsed).toEqual({ stack: Option.some("feature-a"), stackId: Option.none() });
    }).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, CliOutput.layer(textCliOutputFormatter()))),
    );
  });

  it.live("parses env selection and repeated CSV variable overrides", () => {
    let input: { env: boolean; overrideName: ReadonlyArray<string> } | undefined;
    const command = stackStatusCommand.pipe(
      Command.withHandler((parsedFlags) =>
        Effect.sync(() => {
          input = { env: parsedFlags.env, overrideName: parsedFlags.overrideName };
        }),
      ),
    );
    return Effect.gen(function* () {
      yield* Command.runWith(command, { version: "0.0.0-test" })([
        "--env",
        "--override-name",
        "API_URL=APP_URL,ANON_KEY=APP_KEY",
        "--override-name",
        "DB_URL=DATABASE_URL",
      ]);
      expect(input?.env).toBe(true);
      expect(input?.overrideName).toEqual([
        "API_URL=APP_URL",
        "ANON_KEY=APP_KEY",
        "DB_URL=DATABASE_URL",
      ]);
    }).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, CliOutput.layer(textCliOutputFormatter()))),
    );
  });

  it.effect("exports the running stack credentials as dotenv with renamed variables", () => {
    return withRunStatus(
      {
        config: "invalid",
        flags: { ...flags(), env: true, overrideName: ["API_URL=NEXT_PUBLIC_SUPABASE_URL"] },
      },
      (run) =>
        run.effect.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              expect(parseDotenv(run.out.stdoutText)).toEqual({
                NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
                DB_URL: "postgresql://postgres:p%40ss@127.0.0.1:54322/postgres",
                ANON_KEY: "anon-token",
                SERVICE_ROLE_KEY: "service-role-token",
                PUBLISHABLE_KEY: "sb_publishable_test",
                SECRET_KEY: "sb_secret_test",
              });
              expect(run.inspectInputs).toHaveLength(0);
            }),
          ),
        ),
    );
  });

  const exportedVariables = {
    API_URL: "http://127.0.0.1:54321",
    DB_URL: "postgresql://postgres:p%40ss@127.0.0.1:54322/postgres",
    ANON_KEY: "anon-token",
    SERVICE_ROLE_KEY: "service-role-token",
    PUBLISHABLE_KEY: "sb_publishable_test",
    SECRET_KEY: "sb_secret_test",
  };
  const VariableMapJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

  it.effect("exports a bare variable map in json", () => {
    return withRunStatus({ flags: { ...flags(), env: true }, outputFormat: "json" }, (run) =>
      Effect.gen(function* () {
        yield* run.effect;
        const variables = yield* Schema.decodeEffect(VariableMapJson)(run.out.stdoutText.trim());
        expect(variables).toEqual(exportedVariables);
        expect(run.out.messages).toEqual([]);
      }),
    );
  });

  it.effect("exports a variable map as a stream-json result event", () => {
    return withRunStatus({ flags: { ...flags(), env: true }, outputFormat: "stream-json" }, (run) =>
      run.effect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const results = run.out.events.flatMap((event) =>
              event.type === "result" ? [event.data] : [],
            );
            expect(results).toEqual([exportedVariables]);
            expect(run.out.stdoutText).toBe("");
          }),
        ),
      ),
    );
  });

  it.effect("exports optional service URLs and storage credentials only when available", () => {
    const status: StackStatus = {
      ...makeStatus(id),
      endpoints: {
        studio: {
          protocol: "http",
          address: "127.0.0.1",
          port: 54323,
          url: "http://127.0.0.1:54323",
        },
        mailUi: {
          protocol: "http",
          address: "127.0.0.1",
          port: 54324,
          url: "http://127.0.0.1:54324",
        },
      },
    };
    return withRunStatus(
      { flags: { ...flags(), env: true }, status, storageCredentials: true },
      (run) =>
        run.effect.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              const values = parseDotenv(run.out.stdoutText);
              expect(values.API_URL).toBeUndefined();
              expect(values).toMatchObject({
                STUDIO_URL: "http://127.0.0.1:54323",
                INBUCKET_URL: "http://127.0.0.1:54324",
                S3_PROTOCOL_ACCESS_KEY_SECRET: "storage-secret",
                S3_PROTOCOL_REGION: "local",
              });
            }),
          ),
        ),
    );
  });

  it.effect("exports a database-only stack without inventing API credentials", () => {
    return withRunStatus(
      {
        flags: { ...flags(), env: true },
        status: { ...makeStatus(id), endpoints: {} },
        authDisabled: true,
      },
      (run) =>
        run.effect.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              expect(parseDotenv(run.out.stdoutText)).toEqual({
                DB_URL: "postgresql://postgres:p%40ss@127.0.0.1:54322/postgres",
              });
            }),
          ),
        ),
    );
  });

  it.effect("keeps ordinary status independent of credentials and free of secrets", () => {
    return withRunStatus({ status: makeStatus(id), credentialFailure: true }, (run) =>
      run.effect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(run.out.stdoutText).toContain("Lifecycle: running");
            expect(run.out.stdoutText).not.toContain("sb_secret_test");
          }),
        ),
      ),
    );
  });

  it.effect("rejects invalid or colliding variable renames before discovery", () => {
    const cases: ReadonlyArray<Partial<ReturnType<typeof flags>>> = [
      { overrideName: ["API_URL=APP_URL"] },
      { env: true, overrideName: ["UNKNOWN=APP_URL"] },
      { env: true, overrideName: ["API_URL=NOT-VALID"] },
      { env: true, overrideName: ["API_URL=DB_URL"] },
      { env: true, overrideName: ["API_URL"] },
      { env: true, overrideName: ["API_URL=A=B"] },
      { env: true, overrideName: ["API_URL=A", "API_URL=B"] },
    ];
    return Effect.forEach(cases, (overrides) => {
      return withRunStatus({ flags: { ...flags(), ...overrides } }, (run) =>
        run.effect.pipe(
          Effect.exit,
          Effect.tap((exit) =>
            Effect.sync(() => {
              expect(Exit.isFailure(exit)).toBe(true);
              expect(run.findInputs).toHaveLength(0);
              expect(run.out.stdoutText).toBe("");
            }),
          ),
        ),
      );
    });
  });

  it.effect("exports no partial secrets when the stack is stopped or credentials fail", () => {
    return Effect.all([
      runStatus({
        flags: { ...flags(), env: true },
        status: { ...makeStatus(id), lifecycle: "stopped" },
      }),
      runStatus({
        flags: { ...flags(), env: true },
        credentialFailure: true,
      }),
    ]).pipe(
      Effect.flatMap(([stopped, failedCredentials]) =>
        Effect.gen(function* () {
          const stoppedError = yield* stopped.effect.pipe(Effect.flip);
          expect(stoppedError.reason).toBe("lifecycle");
          expect(stoppedError[ErrorActionabilityId]).toEqual(actionability.startStack);
          expect(stopped.out.stdoutText).toBe("");
          const failedExit = yield* failedCredentials.effect.pipe(Effect.exit);
          expect(Exit.isFailure(failedExit)).toBe(true);
          expect(failedCredentials.out.stdoutText).toBe("");
        }),
      ),
    );
  });
});
