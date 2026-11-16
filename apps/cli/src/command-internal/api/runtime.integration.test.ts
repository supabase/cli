import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from "effect";
import { CliOutput, Command } from "effect/cli";
import { TestClock } from "effect/testing";
import {
  buildTestRuntime,
  jsonResponse,
  mockCommandPlatformApi,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockTelemetryStateTracked,
  useTempWorkdir,
  VALID_REF,
  withConfigEnv,
} from "../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockProcessControl } from "../../../tests/helpers/mocks.ts";
import {
  HostedMutationConsentRequiredError,
  HostedMutationDeclinedError,
} from "../hosted-consent/hosted-consent.errors.ts";
import { ApiCommandWaitError } from "./errors.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { ROOT_GLOBAL_FLAGS, YesFlag } from "../global-flags.ts";
import { TargetPolicy, readTargetPolicy } from "../target/target-policy.ts";
import { textCliOutputFormatter } from "../../shared/output/text-formatter.ts";
import { makeApiCommand } from "./api.command.ts";
import type { ApiCommandData } from "./model.ts";
import {
  executeApiCommand,
  validateApiCommand,
  withApiCommandErrors,
  type ApiCommandFlags,
} from "./runtime.ts";

const childRef = "bbbbbbbbbbbbbbbbbbbb";
const command: ApiCommandData = {
  operationId: "v2-create-a-branch",
  httpMethod: "POST",
  path: "/v2/projects/{ref}/branches",
  group: "branches",
  method: "create",
  summary: "Create a branch",
  description: "Create a branch",
  experimental: true,
  fields: [
    {
      name: "name",
      path: ["data", "attributes", "name"],
      type: "string",
      required: true,
      repeatable: false,
      description: "Branch name",
    },
    {
      name: "git-branch",
      path: ["data", "attributes", "git_branch"],
      type: "string",
      required: false,
      repeatable: false,
      description: "Git branch",
    },
    {
      name: "region",
      path: ["data", "attributes", "region"],
      type: "string",
      required: false,
      repeatable: false,
      description: "Region",
    },
    {
      name: "persistent",
      path: ["data", "attributes", "persistent"],
      type: "boolean",
      required: false,
      repeatable: false,
      description: "Keep branch",
    },
  ],
  constants: [{ path: ["data", "type"], value: "branch" }],
  wait: {
    read: "v1-get-project",
    params: { ref: "/data/attributes/project_ref" },
    status: "/status",
    succeeded: ["ACTIVE_HEALTHY"],
    failed: ["UNHEALTHY"],
  },
};
const accepted = {
  data: {
    type: "branch",
    id: "11111111-1111-4111-8111-111111111111",
    attributes: {
      name: "preview",
      project_ref: childRef,
      parent_project_ref: VALID_REF,
      is_default: false,
      persistent: false,
      with_data: false,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  },
};
const status = (value: string) => ({ id: childRef, name: "preview", status: value });
const temp = useTempWorkdir("api-command-");
const cliCommand = makeApiCommand(command);
const root = Command.make("supabase").pipe(
  Command.withSubcommands([
    cliCommand.pipe(
      Command.withHandler((flags) =>
        validateApiCommand(command, flags).pipe(
          Effect.flatMap((timeout) => executeApiCommand(command, flags, timeout)),
        ),
      ),
    ),
  ]),
  Command.withGlobalFlags(ROOT_GLOBAL_FLAGS),
);

function setup(
  options: {
    status?: string;
    statusCode?: number;
    accepted?: unknown;
    seen?: Deferred.Deferred<void>;
    env?: Record<string, string>;
  } = {},
) {
  const out = mockOutput({ format: "json" });
  const api = mockCommandPlatformApi({
    handler: (request) => {
      if (request.method === "POST")
        return Effect.succeed(
          jsonResponse(
            request,
            options.statusCode ?? 202,
            options.statusCode
              ? { error: { code: "branch_conflict", message: "Branch already exists" } }
              : (options.accepted ?? accepted),
          ),
        );
      return (options.seen ? Deferred.succeed(options.seen, undefined) : Effect.void).pipe(
        Effect.as(jsonResponse(request, 200, status(options.status ?? "ACTIVE_HEALTHY"))),
      );
    },
  });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api,
      cliSettings: mockCommandSettings({ workdir: temp.current }),
      telemetry: telemetry.layer,
      linkedProjectCache: cache.layer,
    }),
    CliOutput.layer(textCliOutputFormatter()),
    Layer.succeed(TargetPolicy, Option.getOrThrow(readTargetPolicy(cliCommand))),
  );
  const run = (flags: string[] = [], defaults = true) => {
    const args = [
      "create",
      "--name",
      "preview",
      `--remote=${VALID_REF}`,
      ...(defaults ? ["--experimental", "--yes"] : []),
      ...flags,
    ];
    return withConfigEnv(
      options.env ?? {},
      Command.runWith(root, { version: "test" })(args).pipe(
        Effect.provideService(CliArgs, { args }),
        Effect.provide(layer),
      ),
    );
  };
  return { out, api, run, telemetry, cache, layer };
}

describe("generated API runtime", () => {
  it.effect("maps scalar flags to a direct request and returns raw acceptance", () => {
    const t = setup();
    return Effect.gen(function* () {
      yield* t.run(["--git-branch", "feature,2026", "--persistent"]);
      expect(t.api.requests).toHaveLength(1);
      expect(t.api.requests[0]).toMatchObject({
        method: "POST",
        url: expect.stringContaining(`/v2/projects/${VALID_REF}/branches`),
        body: {
          data: {
            type: "branch",
            attributes: { name: "preview", git_branch: "feature,2026", persistent: true },
          },
        },
      });
      expect(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(t.out.stdoutText),
      ).toEqual(accepted);
      expect(t.cache.cached).toBe(true);
      expect(t.telemetry.flushed).toBe(true);
    });
  });
  it.effect("omits absent optional fields", () => {
    const t = setup();
    return Effect.gen(function* () {
      yield* t.run();
      expect(t.api.requests[0]?.body).toEqual({
        data: { type: "branch", attributes: { name: "preview" } },
      });
    });
  });
  it.effect(
    "binds polling to the accepted resource and trusts the configured completion status",
    () => {
      const t = setup();
      return Effect.gen(function* () {
        yield* t.run(["--wait"]);
        expect(t.api.requests).toHaveLength(2);
        expect(t.api.requests[1]).toMatchObject({
          method: "GET",
          url: expect.stringContaining(`/v1/projects/${childRef}`),
        });
        expect(
          yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(t.out.stdoutText),
        ).toEqual(status("ACTIVE_HEALTHY"));
      });
    },
  );
  it.effect("reports API conflicts on stderr without success and flushes bookkeeping", () => {
    const t = setup({ statusCode: 409 });
    return Effect.gen(function* () {
      yield* t.run(["--wait"]).pipe(withApiCommandErrors, Effect.provide(t.layer));
      expect(t.api.requests).toHaveLength(1);
      expect(t.out.stdoutText).toBe("");
      expect(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
          t.out.stderrText.trim().split("\n").at(-1) ?? "",
        ),
      ).toMatchObject({
        status: 409,
        api_code: "branch_conflict",
        message: "Branch already exists",
      });
      expect(t.cache.cached).toBe(true);
      expect(t.telemetry.flushed).toBe(true);
    });
  });
  it.effect.each([
    {
      label: "failed",
      options: { status: "UNHEALTHY" },
      message: "Operation ended with status UNHEALTHY.",
    },
    {
      label: "missing polling identity",
      options: { accepted: { data: { id: VALID_REF, attributes: { accepted: true } } } },
      message: "omitted a required polling parameter",
    },
  ])("fails promptly on $label", ({ options, message }) => {
    const t = setup(options);
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(t.run(["--wait"]));
      expect(Exit.findErrorOption(exit)).toEqual(
        Option.some(
          expect.objectContaining({
            _tag: "ApiCommandWaitError",
            message: expect.stringContaining(message),
          }),
        ),
      );
      expect(t.out.stdoutText).toBe("");
      expect(t.api.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    });
  });
  it.effect.each(["timeout", "interrupt"] as const)(
    "%s stops polling without cancelling accepted work",
    (end) =>
      Effect.gen(function* () {
        const seen = yield* Deferred.make<void>();
        const t = setup({ status: "COMING_UP", seen });
        const fiber = yield* t.run(["--wait", "--timeout", "3s"]).pipe(Effect.forkScoped);
        yield* Deferred.await(seen);
        if (end === "timeout") yield* TestClock.adjust("3 seconds");
        else yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
        if (end === "timeout")
          expect(Exit.findErrorOption(exit)).toEqual(
            Option.some(
              expect.objectContaining({
                _tag: "ApiCommandWaitError",
                message: expect.stringContaining("Timed out"),
              }),
            ),
          );
        expect(t.api.requests.filter((r) => r.method !== "GET")).toHaveLength(1);
        expect(t.out.stdoutText).toBe("");
        expect(t.telemetry.flushed).toBe(true);
      }),
  );
  it.effect.each([
    { args: ["--yes"], env: {}, allowed: false },
    { args: ["--yes", "--experimental"], env: {}, allowed: true },
    { args: ["--yes"], env: { SUPABASE_EXPERIMENTAL: "1" }, allowed: true },
    {
      args: ["--yes", "--experimental=false"],
      env: { SUPABASE_EXPERIMENTAL: "1" },
      allowed: false,
    },
    { args: ["--yes", "--region", "--experimental"], env: {}, allowed: false },
  ])("honors the independent execution gate: $args $env", ({ args, env, allowed }) => {
    const t = setup({
      env: Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(t.run(args, false));
      if (allowed) expect(Exit.isSuccess(exit)).toBe(true);
      else {
        expect(Exit.findErrorOption(exit)).toEqual(
          Option.some(
            expect.objectContaining({
              _tag: args.includes("--region") ? "ShowHelp" : "ExperimentalRequiredError",
            }),
          ),
        );
        expect(t.api.requests).toHaveLength(0);
        expect(t.cache.cached).toBe(false);
        expect(t.telemetry.flushed).toBe(false);
      }
    });
  });
  it.effect.each(["0", "invalid"])("rejects timeout %s before making requests", (timeout) => {
    const t = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(t.run(["--timeout", timeout]));
      expect(Exit.findErrorOption(exit)).toEqual(
        Option.some(expect.objectContaining({ _tag: "ApiCommandInputError" })),
      );
      expect(t.api.requests).toHaveLength(0);
    });
  });
});

it.effect.each([
  {
    error: new HostedMutationDeclinedError({ message: "context canceled" }),
    exitCode: 130,
    code: "api_error",
  },
  {
    error: new ApiCommandWaitError({
      reason: "timeout",
      message: "Still running",
      suggestion: "Inspect the resource",
    }),
    exitCode: 1,
    code: "wait_timeout",
  },
])("renders $code with exit $exitCode and no success output", ({ error, exitCode, code }) => {
  const out = mockOutput({ format: "json" });
  const process = mockProcessControl();
  return Effect.gen(function* () {
    yield* Effect.fail(error).pipe(withApiCommandErrors);
    expect(process.exitCode).toBe(exitCode);
    expect(out.stdoutText).toBe("");
    expect(
      yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(out.stderrText),
    ).toMatchObject({
      code,
      status: null,
      message: error.message,
    });
  }).pipe(Effect.provide(Layer.mergeAll(out.layer, process.layer)));
});

const consentFlags: ApiCommandFlags = {
  remote: Option.some({ _tag: "Ref", ref: VALID_REF }),
  projectRef: Option.none(),
  input: { name: "preview" },
  wait: false,
  timeout: "15m",
};
it.effect("refuses a generated API mutation without hosted consent", () => {
  const t = setup();
  return Effect.gen(function* () {
    const exit = yield* withConfigEnv({}, executeApiCommand(command, consentFlags, 900_000)).pipe(
      Effect.provideService(YesFlag, false),
      Effect.provide(t.layer),
      Effect.exit,
    );
    expect(Exit.findErrorOption(exit)).toEqual(
      Option.some(expect.any(HostedMutationConsentRequiredError)),
    );
    expect(t.api.requests).toEqual([]);
    expect(t.out.stdoutText).toBe("");
  });
});
