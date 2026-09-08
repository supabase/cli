// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem test fixture uses the host adapter at this boundary
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem test fixture uses the host adapter at this boundary
import { join } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, Redacted, Stream } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import {
  InvalidStackConfigError,
  StackNotFoundError,
  StackNotRunningError,
  StackIdSchema,
  StackStateFormatUnsupportedError,
  type StackInspection,
  type StackStatus,
} from "@supabase/stack/effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { mockLegacyCliSettings } from "../../../../../tests/helpers/legacy-mocks.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import {
  actionability,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";
import { LegacyExperimentalStackApi } from "../stack.shared.ts";
import { legacyExperimentalStackStatus } from "./status.handler.ts";
import { legacyExperimentalStackStatusCommand } from "./status.command.ts";
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
  readonly credentialFailure?: boolean;
  readonly storageCredentials?: boolean;
  readonly authDisabled?: boolean;
  readonly status?: StackStatus;
  readonly drift?: StackInspection["configDrift"];
  readonly flags?: ReturnType<typeof flags>;
  readonly compareFailure?: "typed" | "defect";
  readonly missingTarget?: boolean;
  readonly legacyOutput?: boolean;
  readonly outputFormat?: "text" | "json" | "stream-json";
}) => {
  const root = mkdtempSync(join(tmpdir(), "supabase-stack-status-"));
  const projectRoot = join(root, "project");
  mkdirSync(join(projectRoot, "supabase"), { recursive: true });
  if (options.config !== "missing")
    writeFileSync(
      join(projectRoot, "supabase", "config.toml"),
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
  const findInputs: unknown[] = [];
  const inspectInputs: unknown[] = [];
  const api = Layer.succeed(LegacyExperimentalStackApi, {
    createStack: () => Effect.die("create must not run"),
    findStack: (input) => {
      findInputs.push(input);
      return Effect.succeed(options.missingTarget ? Option.none() : Option.some(descriptor));
    },
    listStacks: () => Effect.succeed([]),
    discoverStacks: () => Effect.succeed({ stacks: [], errors: [] }),
    openStack: () =>
      Effect.succeed({
        id,
        status: () => Effect.succeed(options.status ?? makeStatus(id)),
        credentials: () =>
          options.credentialFailure
            ? Effect.fail(
                new StackNotRunningError({ stackId: id, message: "Stack is not running" }),
              )
            : Effect.succeed({
                database: {
                  url: Redacted.make("postgresql://postgres:p%40ss@127.0.0.1:54322/postgres"),
                  password: Redacted.make("p@ss"),
                },
                ...(options.authDisabled
                  ? {}
                  : {
                      api: {
                        anonJwt: "anon-token",
                        serviceRoleJwt: Redacted.make("service-role-token"),
                        publishableKey: "sb_publishable_test",
                        secretKey: Redacted.make("sb_secret_test"),
                      },
                    }),
                ...(options.storageCredentials
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
        stop: () => Effect.die("unused"),
        destroy: () => Effect.die("unused"),
        logs: () => Effect.die("unused"),
        followLogs: () => Stream.empty,
      }),
    inspectStack: (_stackId, inspectOptions) => {
      inspectInputs.push(inspectOptions);
      if (options.missingTarget === true)
        return Effect.fail(new StackNotFoundError({ message: "stack id not found" }));
      if (inspectOptions?.config !== undefined && options.compareFailure === "typed")
        return Effect.fail(new InvalidStackConfigError({ message: "candidate config is invalid" }));
      if (inspectOptions?.config !== undefined && options.compareFailure === "defect")
        return Effect.die("comparison defect");
      return Effect.succeed(inspection);
    },
  });
  const layer = Layer.mergeAll(
    out.layer,
    api,
    mockLegacyCliSettings({ workdir: root }),
    ...(options.legacyOutput === true
      ? [Layer.succeed(LegacyOutputFlag, Option.some("json"))]
      : []),
    BunServices.layer,
  );
  const effect = legacyExperimentalStackStatus(options.flags ?? flags()).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
  );
  return { effect, out, findInputs, inspectInputs, projectRoot, root };
};

describe("experimental stack status", () => {
  it.effect(
    "reports configured identity, dormant readiness, endpoint, drift, and target config",
    () => {
      const run = runStatus({
        status: makeStatus(id),
        drift: { status: "changed", paths: ["definition.listeners.api.port"] },
      });
      return run.effect.pipe(
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
      );
    },
  );

  it.effect("forwards a named stack target with the settings project root", () => {
    const run = runStatus({ flags: flags(Option.some("feature-a")), status: makeStatus(id) });
    return run.effect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(run.findInputs).toEqual([{ projectRoot: run.root, name: "feature-a" }]);
        }),
      ),
    );
  });

  it.effect("uses the persisted project root for an explicit id from another cwd", () => {
    const run = runStatus({ flags: flags(Option.none(), Option.some(id)), status: makeStatus(id) });
    return run.effect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(run.inspectInputs).toHaveLength(2);
          expect(run.inspectInputs[1]).toEqual({ config: expect.any(Object) });
        }),
      ),
    );
  });

  it.effect("reuses the explicit id inspection when config is missing", () => {
    const run = runStatus({
      config: "missing",
      flags: flags(Option.none(), Option.some(id)),
      status: makeStatus(id),
    });
    return run.effect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(run.inspectInputs).toHaveLength(1);
          expect(run.inspectInputs[0]).toBeUndefined();
        }),
      ),
    );
  });

  it.effect("reports stopped and unreachable stacks without claiming live readiness", () => {
    const run = runStatus({ owner: "absent" });
    return run.effect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(run.out.stdoutText).toContain("Lifecycle: unavailable");
          expect(run.out.stdoutText).toContain("Desired lifecycle: running");
          expect(run.out.stdoutText).toContain("Readiness: unknown");
        }),
      ),
    );
  });

  it.effect("does not claim ready when a running stack has stopped capabilities", () => {
    const base = makeStatus(id);
    const run = runStatus({
      status: {
        ...base,
        capabilities: base.capabilities.map((capability, index) =>
          index === 0 ? { ...capability, state: "stopped" as const } : capability,
        ),
      },
    });
    return run.effect.pipe(
      Effect.tap(() =>
        Effect.sync(() => expect(run.out.stdoutText).toContain("Readiness: stopped")),
      ),
    );
  });

  it.effect("emits the structured unavailable inspection for missing config", () => {
    const run = runStatus({
      config: "missing",
      flags: flags(Option.none(), Option.some(id)),
      outputFormat: "json",
    });
    return run.effect.pipe(
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
              message: expect.any(String),
            },
          });
        }),
      ),
    );
  });

  it.effect("uses the live desired lifecycle consistently in text and JSON", () => {
    const text = runStatus({ status: makeStatus(id, "stopped") });
    const json = runStatus({ status: makeStatus(id, "stopped"), outputFormat: "json" });
    return Effect.all([text.effect, json.effect]).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(text.out.stdoutText).toContain("Desired lifecycle: stopped");
          const success = json.out.messages.find((message) => message.type === "success");
          expect(success?.data).toMatchObject({ desired_lifecycle: "stopped" });
        }),
      ),
    );
  });

  it.effect("reports unavailable drift for missing or invalid config and keeps inspection", () => {
    const missing = runStatus({ config: "missing", status: makeStatus(id) });
    const invalid = runStatus({ config: "invalid", status: makeStatus(id) });
    const invalidJson = runStatus({
      config: "invalid",
      status: makeStatus(id),
      outputFormat: "json",
    });
    return Effect.all([missing.effect, invalid.effect, invalidJson.effect]).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(missing.out.stdoutText).toContain("Config drift: unavailable");
          expect(invalid.out.stdoutText).toContain("Config drift: unavailable");
          expect(invalid.out.stdoutText).not.toContain("FAKE_STATUS_SECRET");
          const success = invalidJson.out.messages.find((message) => message.type === "success");
          expect(success?.data).toMatchObject({
            config_drift: {
              status: "unavailable",
              message: "Project configuration could not be loaded; fix it before checking drift.",
            },
          });
          // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- assertion checks redaction of serialized output
          expect(JSON.stringify(success?.data)).not.toContain("FAKE_STATUS_SECRET");
        }),
      ),
    );
  });

  it.effect("points an empty current context to the start command", () => {
    const run = runStatus({ missingTarget: true });
    return run.effect.pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.suggestion).toBe("Run supabase stack start first.");
          expect(run.inspectInputs).toEqual([]);
        }),
      ),
    );
  });

  it.effect("gives actionable guidance when an explicit stack id is missing", () => {
    const run = runStatus({
      flags: flags(Option.none(), Option.some(id)),
      missingTarget: true,
    });
    return run.effect.pipe(
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
    );
  });

  it.effect("falls back only for typed comparison errors and preserves defects", () => {
    const typed = runStatus({ compareFailure: "typed", status: makeStatus(id) });
    const defect = runStatus({ compareFailure: "defect", status: makeStatus(id) });
    return Effect.gen(function* () {
      yield* typed.effect;
      expect(typed.inspectInputs).toHaveLength(2);
      expect(typed.out.stdoutText).toContain("Config drift: unavailable");
      const exit = yield* defect.effect.pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(defect.inspectInputs).toHaveLength(1);
    });
  });

  it.effect("rejects invalid flags and legacy output before discovery", () => {
    const invalid = runStatus({ flags: flags(Option.some("feature-a"), Option.some(id)) });
    const legacy = runStatus({ legacyOutput: true });
    return Effect.gen(function* () {
      expect(Exit.isFailure(yield* invalid.effect.pipe(Effect.exit))).toBe(true);
      expect(Exit.isFailure(yield* legacy.effect.pipe(Effect.exit))).toBe(true);
      expect(invalid.findInputs).toHaveLength(0);
      expect(legacy.findInputs).toHaveLength(0);
    });
  });

  it.effect("parses env selection and repeated CSV variable overrides", () =>
    Command.runWith(
      legacyExperimentalStackStatusCommand.pipe(
        Command.withHandler((input) =>
          Effect.sync(() => {
            expect(input.env).toBe(true);
            expect(input.overrideName).toEqual([
              "API_URL=APP_URL",
              "ANON_KEY=APP_KEY",
              "DB_URL=DATABASE_URL",
            ]);
          }),
        ),
      ),
      { version: "0.0.0-test" },
    )([
      "--env",
      "--override-name",
      "API_URL=APP_URL,ANON_KEY=APP_KEY",
      "--override-name",
      "DB_URL=DATABASE_URL",
    ]).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, CliOutput.layer(textCliOutputFormatter()))),
    ),
  );

  it.effect("exports the running stack credentials as dotenv with renamed variables", () => {
    const run = runStatus({
      config: "invalid",
      flags: { ...flags(), env: true, overrideName: ["API_URL=NEXT_PUBLIC_SUPABASE_URL"] },
    });
    return run.effect.pipe(
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
    );
  });

  for (const outputFormat of ["json", "stream-json"] as const) {
    it.effect(`exports a variable map in ${outputFormat}`, () => {
      const run = runStatus({ outputFormat, flags: { ...flags(), env: true } });
      return run.effect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(
              run.out.messages.find((message) => message.type === "success")?.data,
            ).toMatchObject({ API_URL: "http://127.0.0.1:54321", SECRET_KEY: "sb_secret_test" });
            expect(run.out.stdoutText).toBe("");
          }),
        ),
      );
    });
  }

  it.effect("exports optional service URLs and storage credentials only when available", () => {
    const run = runStatus({
      storageCredentials: true,
      flags: { ...flags(), env: true },
      status: {
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
      },
    });
    return run.effect.pipe(
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
    );
  });

  it.effect("exports a database-only stack without inventing API credentials", () => {
    const run = runStatus({
      authDisabled: true,
      flags: { ...flags(), env: true },
      status: { ...makeStatus(id), endpoints: {} },
    });
    return run.effect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(parseDotenv(run.out.stdoutText)).toEqual({
            DB_URL: "postgresql://postgres:p%40ss@127.0.0.1:54322/postgres",
          });
        }),
      ),
    );
  });

  it.effect("keeps ordinary status independent of credentials and free of secrets", () => {
    const run = runStatus({ status: makeStatus(id), credentialFailure: true });
    return run.effect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(run.out.stdoutText).toContain("Lifecycle: running");
          expect(run.out.stdoutText).not.toContain("sb_secret_test");
        }),
      ),
    );
  });

  it.effect("rejects invalid or colliding variable renames before discovery", () =>
    Effect.forEach(
      [
        { ...flags(), overrideName: ["API_URL=APP_URL"] },
        { ...flags(), env: true, overrideName: ["UNKNOWN=APP_URL"] },
        { ...flags(), env: true, overrideName: ["API_URL=NOT-VALID"] },
        { ...flags(), env: true, overrideName: ["API_URL=DB_URL"] },
        { ...flags(), env: true, overrideName: ["API_URL"] },
        { ...flags(), env: true, overrideName: ["API_URL=A=B"] },
      ],
      (input) =>
        Effect.gen(function* () {
          const run = runStatus({ flags: input });
          expect(Exit.isFailure(yield* run.effect.pipe(Effect.exit))).toBe(true);
          expect(run.findInputs).toHaveLength(0);
          expect(run.out.stdoutText).toBe("");
        }),
    ),
  );

  it.effect("exports no partial secrets when the stack is stopped or credentials fail", () =>
    Effect.forEach(
      [
        { status: { ...makeStatus(id), lifecycle: "stopped" as const } },
        { credentialFailure: true },
      ],
      (options) =>
        Effect.gen(function* () {
          const run = runStatus({ ...options, flags: { ...flags(), env: true } });
          expect(Exit.isFailure(yield* run.effect.pipe(Effect.exit))).toBe(true);
          expect(run.out.stdoutText).toBe("");
        }),
    ),
  );

  it.effect("does not retry discovery failures", () => {
    const run = runStatus({});
    const discovery = Layer.succeed(LegacyExperimentalStackApi, {
      createStack: () => Effect.die("create must not run"),
      findStack: () =>
        Effect.fail(new StackStateFormatUnsupportedError({ message: "discovery failed" })),
      listStacks: () => Effect.succeed([]),
      discoverStacks: () => Effect.succeed({ stacks: [], errors: [] }),
      openStack: () => Effect.die("open must not run"),
      inspectStack: () => Effect.die("inspect must not run"),
    });
    const effect = legacyExperimentalStackStatus(flags()).pipe(
      Effect.provide(
        Layer.mergeAll(
          run.out.layer,
          discovery,
          mockLegacyCliSettings({ workdir: run.projectRoot }),
          BunServices.layer,
        ),
      ),
      Effect.ensuring(Effect.sync(() => rmSync(run.root, { recursive: true, force: true }))),
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

  it.live("parses stack name and stack id through the command", () => {
    let parsed: { stack: Option.Option<string>; stackId: Option.Option<string> } | undefined;
    const command = legacyExperimentalStackStatusCommand.pipe(
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
});
