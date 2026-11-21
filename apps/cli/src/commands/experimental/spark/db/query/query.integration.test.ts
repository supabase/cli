import { describe, expect, it } from "@effect/vitest";
import type { ServiceInstance, Stack, StackCredentials } from "@supabase/stack/effect";
import { Effect, Exit, Layer, Option, Schema, Stream } from "effect";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  buildTestRuntime,
  mockCommandPlatformApi,
  mockCommandSettings,
} from "../../../../../../tests/helpers/command-mocks.ts";
import type { ApiHandler } from "../../../../../../tests/helpers/command-mocks.ts";
import { describeHostedConsent } from "../../../../../../tests/helpers/hosted-consent.ts";
import { mockOutput, mockStdin } from "../../../../../../tests/helpers/mocks.ts";
import { unusedGateway } from "../../../../../../tests/helpers/unused-stack.ts";
import { AgentFlag, YesFlag } from "../../../../../command-internal/global-flags.ts";
import { StackApi } from "../../../../../command-internal/stack-api.ts";
import { TargetPolicy } from "../../../../../command-internal/target/target-policy.ts";
import { Random } from "../../../../../shared/runtime/random.service.ts";
import { AiTool } from "../../../../../shared/telemetry/ai-tool.service.ts";
import { TelemetryOutputFormat } from "../../../../../telemetry/telemetry-output-format.service.ts";
import { sparkDbQueryCommand } from "./query.command.ts";
import { sparkDbQuery } from "./query.handler.ts";

const REF = "abcdefghijklmnopqrst";
const BOUNDARY = "00112233445566778899aabbccddeeff";
const API_URL = "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = "local-service-role-key";

const unused = Effect.die("unused by db query");

/** A project stack with a running Spark member, or none when `running` is false. */
const sparkStackApi = (running: boolean) => {
  const spark: ServiceInstance<"spark"> = {
    id: "spark-primary",
    service: "spark",
    start: unused,
    ready: unused,
    stop: unused,
    restart: () => unused,
    destroy: unused,
    prepare: unused,
    status: Effect.succeed({
      id: "spark-primary",
      endpoints: [{ name: "http", protocol: "http", host: "127.0.0.1", port: 54321 }],
      config: {
        service: "spark",
        config: { executable: "/bin/spark", projectRoot: "/work/project" },
        endpoints: {},
      },
      lifecycle: "running",
      health: "healthy",
      error: undefined,
      exit: undefined,
      currentOperation: undefined,
      wakeEnabled: true,
    }),
    followStatus: Stream.empty,
    readLogs: () => Stream.empty,
    credentials: () => Effect.succeed({ url: `${API_URL}/rest/v1`, apiUrl: API_URL }),
  };
  const credentials: StackCredentials = {
    jwtSecret: "secret",
    postgresRootKey: "root",
    databasePassword: "password",
    publishableKey: "publishable",
    secretKey: "secret-key",
    anonKey: "anon",
    serviceRoleKey: SERVICE_ROLE_KEY,
    jwks: "{}",
    gotrueJwtKeys: "[]",
    remoteJwks: "{}",
    anonKeyIsOverride: false,
    serviceRoleKeyIsOverride: false,
  };
  const stack: Stack = {
    id: "s".repeat(64),
    services: { create: () => unused, get: () => unused, list: Effect.succeed([spark]) },
    credentials: { get: Effect.succeed(credentials) },
    composition: {
      plan: () => unused,
      describe: unused,
      supabase: () => unused,
      configure: () => unused,
      start: unused,
      stop: unused,
      restart: unused,
    },
    startupEndpointChanges: unused,
    stop: unused,
    destroy: unused,
    gateway: unusedGateway,
    commands: { run: () => unused },
  };
  return Layer.succeed(StackApi, {
    create: () => unused,
    open: () => Effect.succeed(stack),
    discover: () => unused,
    find: () =>
      Effect.succeed(
        running
          ? Option.some({
              definition: {
                id: stack.id,
                identity: {
                  projectRoot: "/work/project",
                  branchContext: "main",
                  stackName: "default",
                },
                runtime: "native" as const,
                instances: [],
                lifetime: "detached" as const,
                composition: { members: [], dependencies: [] },
              },
              host: undefined,
            })
          : Option.none(),
      ),
    findDeleted: () => unused,
  });
};

const answer =
  (body: string, status = 201): ApiHandler =>
  (request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status })));

function setup(opts: {
  readonly handler: ApiHandler;
  readonly agent?: "yes" | "no";
  readonly stack?: boolean;
  readonly yes?: boolean;
}) {
  const out = mockOutput({ format: "text" });
  const api = mockCommandPlatformApi({ handler: opts.handler });
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api,
      cliSettings: mockCommandSettings({ workdir: "/work/project" }),
      stdin: mockStdin(true),
    }),
    sparkStackApi(opts.stack ?? true),
    Layer.succeed(TargetPolicy, { group: "selectable", consent: "no" }),
    Layer.succeed(YesFlag, opts.yes ?? true),
    Layer.succeed(AgentFlag, opts.agent ?? "no"),
    Layer.succeed(Random, { randomHex: () => Effect.succeed(BOUNDARY) }),
    Layer.succeed(AiTool, { name: Option.none() }),
    Layer.succeed(TelemetryOutputFormat, {
      set: () => Effect.void,
      get: Effect.succeed(Option.none()),
    }),
  );
  return { layer, out, api };
}

const flags = (over: Partial<Parameters<typeof sparkDbQuery>[0]> = {}) => ({
  sql: Option.none<string>(),
  file: Option.none<string>(),
  readOnly: false,
  remote: Option.none(),
  local: false,
  linked: false,
  projectRef: Option.none<string>(),
  ...over,
});

const linked = { remote: Option.some({ _tag: "Ref", ref: REF } as const) };

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const ROWS = '[{"id":1,"title":"milk"},{"id":2,"title":"eggs"}]';

describe("spark db query integration", () => {
  it.effect(
    "runs on the local Spark server through the stack's API URL and service_role key",
    () => {
      const { layer, out, api } = setup({ handler: answer(ROWS) });
      return Effect.gen(function* () {
        yield* sparkDbQuery(flags({ sql: Option.some("select * from todos") }));
        expect(api.requests.map((r) => r.url)).toEqual([`${API_URL}/database/query`]);
        expect(api.requests[0]?.headers["apikey"]).toBe(SERVICE_ROLE_KEY);
        expect(api.requests[0]?.body).toEqual({
          query: "select * from todos",
          parameters: [],
          read_only: false,
        });
        expect(out.stdoutText).toContain("│ id │ title │");
        expect(out.stderrText).not.toContain("Confirmed by");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("names both ways out when no local stack is running", () => {
    const { layer, api } = setup({ handler: answer(ROWS), stack: false });
    return Effect.gen(function* () {
      const exit = yield* sparkDbQuery(flags({ sql: Option.some("select 1") })).pipe(Effect.exit);
      expect(String(exit)).toContain("No local Spark stack is running for this project");
      expect(String(exit)).toContain("supabase start");
      expect(String(exit)).toContain("--remote");
      expect(api.requests).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("renders rows as a table for a human and as the JSON envelope in agent mode", () => {
    const human = setup({ handler: answer(ROWS) });
    const agent = setup({ handler: answer(ROWS), agent: "yes" });
    return Effect.gen(function* () {
      yield* sparkDbQuery(flags({ sql: Option.some("select * from todos"), ...linked })).pipe(
        Effect.provide(human.layer),
      );
      expect(human.out.stdoutText).toContain("│ id │ title │");
      expect(human.out.stdoutText).toContain("│ 2  │ eggs  │");
      expect(human.api.requests[0]?.url).toContain(`/v1/projects/${REF}/database/query`);
      expect(human.api.requests[0]?.body).toEqual({ query: "select * from todos" });

      yield* sparkDbQuery(flags({ sql: Option.some("select * from todos"), ...linked })).pipe(
        Effect.provide(agent.layer),
      );
      const envelope = yield* decodeJson(agent.out.stdoutText);
      expect(envelope).toMatchObject({
        boundary: BOUNDARY,
        rows: [
          { id: 1, title: "milk" },
          { id: 2, title: "eggs" },
        ],
      });
    });
  });

  it.effect("sends read_only: true with --read-only and needs no confirmation", () => {
    const { layer, out, api } = setup({ handler: answer("[]"), yes: false });
    return Effect.gen(function* () {
      yield* sparkDbQuery(flags({ sql: Option.some("select 1"), readOnly: true, ...linked }));
      expect(api.requests[0]?.body).toEqual({ query: "select 1", read_only: true });
      expect(out.stderrText).not.toContain("Confirmed by");
    }).pipe(Effect.provide(layer));
  });

  it.effect("surfaces the server's message on a non-2xx answer", () => {
    const { layer } = setup({
      handler: answer('{"message":"statement refused in a read-only transaction (25006)"}', 400),
    });
    return Effect.gen(function* () {
      const exit = yield* sparkDbQuery(
        flags({
          sql: Option.some("insert into todos default values"),
          readOnly: true,
          ...linked,
        }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain("statement refused in a read-only transaction (25006)");
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a success that is not the route's 201, and a number JSON cannot carry", () => {
    const page = setup({ handler: answer("<html>\u001b[31msign in</html>", 200) });
    const huge = setup({ handler: answer('[{"n":1e400}]'), agent: "yes" });
    return Effect.gen(function* () {
      const proxied = yield* sparkDbQuery(flags({ sql: Option.some("select 1"), ...linked })).pipe(
        Effect.provide(page.layer),
        Effect.exit,
      );
      expect(String(proxied)).toContain("unexpected status 200: <html>[31msign in</html>");
      expect(page.out.stdoutText).toBe("");

      const encoded = yield* sparkDbQuery(
        flags({ sql: Option.some("select 1e400 as n"), ...linked }),
      ).pipe(Effect.provide(huge.layer), Effect.exit);
      expect(String(encoded)).toContain("json: unsupported value: +Inf");
      expect(huge.out.stdoutText).toBe("");
    });
  });

  it.effect("refuses --file together with a positional SQL", () => {
    const { layer, api } = setup({ handler: answer("[]") });
    return Effect.gen(function* () {
      const exit = yield* sparkDbQuery(
        flags({ sql: Option.some("select 1"), file: Option.some("q.sql") }),
      ).pipe(Effect.exit);
      expect(String(exit)).toContain("Pass SQL as an argument or with --file, not both.");
      expect(api.requests).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});

describeHostedConsent("db query", {
  command: sparkDbQueryCommand,
  api: { response: { status: 201, body: [{ id: 1 }] } },
  invoke: ({ api }) => ({
    run: sparkDbQuery(flags({ sql: Option.some("insert into t values (1)"), ...linked })).pipe(
      Effect.provide(
        Layer.mergeAll(
          sparkStackApi(true),
          Layer.succeed(Random, { randomHex: () => Effect.succeed(BOUNDARY) }),
          Layer.succeed(AiTool, { name: Option.none() }),
          Layer.succeed(TelemetryOutputFormat, {
            set: () => Effect.void,
            get: Effect.succeed(Option.none()),
          }),
        ),
      ),
    ),
    mutations: () => api.requests.filter(({ method }) => method === "POST").length,
  }),
});
