import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Schema } from "effect";
import { CliOutput, Command } from "effect/cli";
import { describeHostedConsent } from "../../../../../tests/helpers/hosted-consent.ts";
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
} from "../../../../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { ROOT_GLOBAL_FLAGS } from "../../../../command-internal/global-flags.ts";
import {
  TargetPolicy,
  readTargetPolicy,
} from "../../../../command-internal/target/target-policy.ts";
import { textCliOutputFormatter } from "../../../../shared/output/text-formatter.ts";
import { generatedCommands } from "../../../../command-internal/api/generated.ts";
import { warehouseEnableCommand } from "./enable.command.ts";
import {
  executeApiCommand,
  validateApiCommand,
  type ApiCommandFlags,
} from "../../../../command-internal/api/runtime.ts";

const command = generatedCommands[0];
const selectionId = "a".repeat(64);
const accepted = {
  data: {
    type: "warehouse_setup",
    id: VALID_REF,
    attributes: {
      accepted: true,
      selection_id: selectionId,
      selected_tables: [{ id: 1234, schema: "public", name: "orders" }],
      pipeline_id: "101",
      tables: [],
    },
  },
};
const status = (value: string, error?: string) => ({
  data: {
    type: "warehouse_setup",
    id: VALID_REF,
    attributes: { status: value, ...(error ? { status_error: error } : {}) },
  },
});
const temp = useTempWorkdir("warehouse-generated-");
const root = Command.make("supabase").pipe(
  Command.withSubcommands([
    warehouseEnableCommand.pipe(
      Command.withHandler((flags) =>
        validateApiCommand(command, flags).pipe(
          Effect.flatMap((timeout) => executeApiCommand(command, flags, timeout)),
        ),
      ),
    ),
  ]),
  Command.withGlobalFlags(ROOT_GLOBAL_FLAGS),
);

function setup(statusResponse = status("succeeded")) {
  const out = mockOutput({ format: "json" });
  const api = mockCommandPlatformApi({
    handler: (request) =>
      Effect.succeed(
        jsonResponse(
          request,
          request.method === "POST" ? 202 : 200,
          request.method === "POST" ? accepted : statusResponse,
        ),
      ),
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
    Layer.succeed(TargetPolicy, Option.getOrThrow(readTargetPolicy(warehouseEnableCommand))),
  );
  const run = (flags: string[] = []) => {
    const args = [
      "enable",
      "--schema",
      "public",
      `--remote=${VALID_REF}`,
      "--experimental",
      "--yes",
      ...flags,
    ];
    return withConfigEnv(
      {},
      Command.runWith(root, { version: "test" })(args).pipe(
        Effect.provideService(CliArgs, { args }),
        Effect.provide(layer),
      ),
    );
  };
  return { out, api, run, telemetry, cache };
}

describe("generated warehouse enable", () => {
  it.effect("surfaces the setup failure message from Warehouse waiter metadata", () => {
    const t = setup(status("failed", "Initial copy failed"));
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(t.run(["--wait"]));
      expect(Exit.findErrorOption(exit)).toEqual(
        Option.some(
          expect.objectContaining({
            _tag: "ApiCommandWaitError",
            reason: "failed",
            message: "Initial copy failed",
          }),
        ),
      );
      expect(t.api.requests).toHaveLength(2);
      expect(t.out.stdoutText).toBe("");
    });
  });
  it.effect(
    "maps repeated literal names to a direct enable request and returns raw acceptance",
    () => {
      const t = setup();
      return Effect.gen(function* () {
        yield* t.run(["--table", "orders", "--table", "sales,2026", "--install-fdw"]);
        expect(t.api.requests).toHaveLength(1);
        expect(t.api.requests[0]).toMatchObject({
          method: "POST",
          url: expect.stringContaining(`/v2/projects/${VALID_REF}/warehouse/enable`),
          body: {
            data: {
              type: "warehouse_setup",
              attributes: { schema: "public", tables: ["orders", "sales,2026"], install_fdw: true },
            },
          },
        });
        expect(
          yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(t.out.stdoutText),
        ).toEqual(accepted);
        expect(t.cache.cached).toBe(true);
        expect(t.telemetry.flushed).toBe(true);
      });
    },
  );
  it.effect("omits optional fields when selecting a whole schema", () => {
    const t = setup();
    return Effect.gen(function* () {
      yield* t.run();
      expect(t.api.requests[0]?.body).toEqual({
        data: { type: "warehouse_setup", attributes: { schema: "public" } },
      });
    });
  });
  it.effect(
    "binds polling to the accepted selection and trusts the server readiness status",
    () => {
      const t = setup();
      return Effect.gen(function* () {
        yield* t.run(["--wait"]);
        expect(t.api.requests).toHaveLength(2);
        expect(t.api.requests[1]).toMatchObject({
          method: "GET",
          url: expect.stringContaining("/warehouse/setups/current"),
          urlParams: `selection_id=${selectionId}`,
        });
        expect(
          yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(t.out.stdoutText),
        ).toEqual(status("succeeded"));
      });
    },
  );
});

const consentFlags: ApiCommandFlags = {
  remote: Option.some({ _tag: "Ref", ref: VALID_REF }),
  projectRef: Option.none(),
  input: { schema: "public" },
  wait: false,
  timeout: "15m",
};
describeHostedConsent("warehouse enable", {
  command: warehouseEnableCommand,
  api: { response: { status: 202, body: accepted } },
  invoke: ({ api }) => ({
    run: executeApiCommand(command, consentFlags, 900_000),
    mutations: () => api.requests.filter((r) => r.method === "POST").length,
  }),
});
