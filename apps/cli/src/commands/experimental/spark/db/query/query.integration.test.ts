import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Option, Path, Schema } from "effect";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  buildTestRuntime,
  mockCommandPlatformApi,
  mockCommandSettings,
  useTempWorkdir,
} from "../../../../../../tests/helpers/command-mocks.ts";
import type { ApiHandler } from "../../../../../../tests/helpers/command-mocks.ts";
import { describeHostedConsent } from "../../../../../../tests/helpers/hosted-consent.ts";
import { mockOutput, mockStdin } from "../../../../../../tests/helpers/mocks.ts";
import { AgentFlag, YesFlag } from "../../../../../command-internal/global-flags.ts";
import { TargetPolicy } from "../../../../../command-internal/target/target-policy.ts";
import { Random } from "../../../../../shared/runtime/random.service.ts";
import { AiTool } from "../../../../../shared/telemetry/ai-tool.service.ts";
import { TelemetryOutputFormat } from "../../../../../telemetry/telemetry-output-format.service.ts";
import { sparkDbQueryCommand } from "./query.command.ts";
import { sparkDbQuery } from "./query.handler.ts";

const REF = "abcdefghijklmnopqrst";
const DEV_REF = "devinstancerefabcdef";
const BOUNDARY = "00112233445566778899aabbccddeeff";
const API_URL = "https://api.supabase.test";

const workdir = useTempWorkdir("spark-db-query-");

/** The state file `start` leaves once the dev instance is set up. */
const writeDevInstance = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temp = path.join(workdir.current, "supabase", ".temp");
  yield* fs.makeDirectory(temp, { recursive: true });
  yield* fs.writeFileString(
    path.join(temp, "dev-instance.json"),
    `{"ref":"${DEV_REF}","name":"dev-project-abc123","organization_slug":"acme","management_api_url":"${API_URL}","api_url":"https://${DEV_REF}.supabase.test","anon_key":"anon","service_role_key":"service-role"}`,
  );
}).pipe(Effect.provide(BunServices.layer));

const answer =
  (body: string, status = 201): ApiHandler =>
  (request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status })));

function setup(opts: {
  readonly handler: ApiHandler;
  readonly agent?: "yes" | "no";
  readonly yes?: boolean;
}) {
  const out = mockOutput({ format: "text" });
  const api = mockCommandPlatformApi({ handler: opts.handler });
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api,
      cliSettings: mockCommandSettings({ workdir: workdir.current, apiUrl: API_URL }),
      stdin: mockStdin(true),
    }),
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
  linked: false,
  projectRef: Option.none<string>(),
  ...over,
});

const linked = { remote: Option.some({ _tag: "Ref", ref: REF } as const) };

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const ROWS = '[{"id":1,"title":"milk"},{"id":2,"title":"eggs"}]';

describe("spark db query integration", () => {
  it.effect("runs on the dev instance by default and asks no confirmation for a write", () => {
    const { layer, out, api } = setup({ handler: answer(ROWS), yes: false });
    return Effect.gen(function* () {
      yield* writeDevInstance;
      yield* sparkDbQuery(flags({ sql: Option.some("insert into todos default values") }));
      expect(api.requests.map((r) => new URL(r.url).pathname)).toEqual([
        `/v1/projects/${DEV_REF}/database/query`,
      ]);
      expect(api.requests[0]?.body).toEqual({ query: "insert into todos default values" });
      expect(out.stdoutText).toContain("│ id │ title │");
      expect(out.stderrText).not.toContain("Confirmed by");
    }).pipe(Effect.provide(layer));
  });

  it.effect("names supabase start when the checkout has no dev instance", () => {
    const { layer, api } = setup({ handler: answer(ROWS) });
    return Effect.gen(function* () {
      const exit = yield* sparkDbQuery(flags({ sql: Option.some("select 1") })).pipe(Effect.exit);
      expect(String(exit)).toContain("No dev instance for this project");
      expect(String(exit)).toContain("supabase start");
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
