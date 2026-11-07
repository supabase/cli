import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { describeHostedConsent } from "../../../../tests/helpers/hosted-consent.ts";
import {
  buildTestRuntime,
  jsonResponse,
  mockCommandPlatformApi,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockTelemetryStateTracked,
  useTempWorkdir,
  VALID_REF,
} from "../../../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import { OutputFlag, YesFlag } from "../../../command-internal/global-flags.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { warehouseEnable } from "./enable.handler.ts";
import type { WarehouseEnableFlags } from "./enable.command.ts";

const tables = [{ id: 1234, schema: "public", name: "orders" }];
const preview = {
  data: { type: "warehouse_setup_preview", id: VALID_REF, attributes: { selected_tables: tables } },
};
const accepted = {
  data: {
    type: "warehouse_setup",
    id: VALID_REF,
    attributes: { accepted: true, selected_tables: tables, pipeline_id: "101", tables: [] },
  },
};
const status = (setup = "complete", state: string | null = "following_wal", routing = true) => {
  let tableState = "syncing";
  if (state === "following_wal") {
    tableState = "live";
  } else if (state === "error") {
    tableState = "error";
  }

  return {
    data: {
      type: "warehouse_setup",
      id: VALID_REF,
      attributes: {
        setup_status: setup,
        replication_state: "streaming",
        tables: tables.map((table) => ({
          ...table,
          state: tableState,
          replication_state: state,
          copy_name: "public.orders",
        })),
        ...(routing
          ? { dns: { status: "ready", hostname: "warehouse.example.com", region: "eu-west-1" } }
          : {}),
        steps: [],
        fdw_status: null,
      },
    },
  };
};
const flags: WarehouseEnableFlags = {
  remote: Option.some({ _tag: "Ref", ref: VALID_REF }),
  projectRef: Option.none(),
  schema: "public",
  table: Option.none(),
  wait: false,
  timeout: "15m",
};
const root = useTempWorkdir("warehouse-enable-");

function setup(
  options: {
    format?: "text" | "json" | "stream-json";
    statusBody?: unknown;
    applyStatus?: number;
    statusSeen?: Deferred.Deferred<void>;
  } = {},
) {
  const out = mockOutput({ format: options.format ?? "text" });
  const api = mockCommandPlatformApi({
    handler: (request) => {
      if (request.url.endsWith("/preview"))
        return Effect.succeed(jsonResponse(request, 200, preview));
      if (request.method === "POST")
        return Effect.succeed(
          jsonResponse(
            request,
            options.applyStatus ?? 202,
            options.applyStatus
              ? {
                  error: {
                    code: "warehouse_selection_conflict",
                    message: "Warehouse already has a different replication selection",
                  },
                }
              : accepted,
          ),
        );
      return (
        options.statusSeen ? Deferred.succeed(options.statusSeen, undefined) : Effect.void
      ).pipe(Effect.as(jsonResponse(request, 200, options.statusBody ?? status())));
    },
  });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api,
      cliSettings: mockCommandSettings({ workdir: root.current }),
      telemetry: telemetry.layer,
      linkedProjectCache: cache.layer,
    }),
    Layer.succeed(YesFlag, true),
    Layer.succeed(TargetPolicy, { group: "hosted", consent: "no" }),
  );
  return { out, api, layer, telemetry, cache };
}

describe("warehouse enable", () => {
  it.effect("binds the preview identities to setup and reports acceptance without polling", () => {
    const test = setup();
    return Effect.gen(function* () {
      yield* warehouseEnable({ ...flags, table: Option.some("orders") });
      expect(test.api.requests.map((request) => request.method)).toEqual(["POST", "POST"]);
      expect(test.api.requests[0]?.body).toEqual({
        data: {
          type: "warehouse_setup",
          attributes: {
            mode: "enable",
            targets: [{ type: "table", schema: "public", name: "orders" }],
          },
        },
      });
      expect(test.api.requests[1]?.body).toEqual({
        data: {
          type: "warehouse_setup",
          attributes: {
            mode: "enable",
            targets: [{ type: "table", schema: "public", name: "orders" }],
            confirmed_tables: tables,
          },
        },
      });
      expect(test.out.stdoutText).toContain("accepted");
      expect(test.out.stdoutText).not.toContain("Warehouse enabled.");
      expect(test.out.stderrText).toContain('"public"."orders"');
      expect(test.cache.cached).toBe(true);
      expect(test.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(test.layer));
  });

  for (const format of ["json", "stream-json"] as const) {
    it.effect(`emits structured synchronization completion in ${format}`, () => {
      const test = setup({ format });
      return Effect.gen(function* () {
        yield* warehouseEnable({ ...flags, wait: true });
        expect(test.out.messages).toContainEqual(
          expect.objectContaining({
            data: expect.objectContaining({
              accepted: true,
              synchronization_complete: true,
              replication_state: "streaming",
            }),
          }),
        );
        expect(test.out.stdoutText).not.toContain("Selected source tables");
        expect(test.api.requests.at(-1)?.urlParams).toContain("inspect_fdw=false");
      }).pipe(Effect.provide(test.layer));
    });
  }

  it.effect("reports a selection conflict without success and still flushes bookkeeping", () => {
    const test = setup({ applyStatus: 409 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(warehouseEnable(flags));
      expect(Exit.findErrorOption(exit)).toEqual(
        Option.some(
          expect.objectContaining({
            _tag: "WarehouseEnableStatusError",
            status: 409,
            message: expect.stringContaining("replication add/remove"),
          }),
        ),
      );
      expect(test.out.stdoutText).not.toContain("accepted");
      expect(test.cache.cached).toBe(true);
      expect(test.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect.each([
    { name: "unavailable table observations", response: status("complete", null) },
    { name: "missing routing readiness", response: status("complete", "following_wal", false) },
  ])("does not declare synchronization complete with $name and bounds polling", ({ response }) =>
    Effect.gen(function* () {
      const seen = yield* Deferred.make<void>();
      const test = setup({ statusBody: response, statusSeen: seen });
      const fiber = yield* warehouseEnable({ ...flags, wait: true, timeout: "3s" }).pipe(
        Effect.provide(test.layer),
        Effect.forkScoped,
      );
      yield* Deferred.await(seen);
      yield* TestClock.adjust("3 seconds");
      const exit = yield* Fiber.await(fiber);
      expect(Exit.findErrorOption(exit)).toEqual(
        Option.some(expect.objectContaining({ _tag: "WarehouseEnableTimeoutError" })),
      );
      expect(test.out.stdoutText).not.toContain("Warehouse enabled");
      expect(test.api.requests.filter((request) => request.method === "POST")).toHaveLength(2);
      expect(test.telemetry.flushed).toBe(true);
    }),
  );

  it.effect.each(["error", "deletion_failed"])(
    "surfaces %s without waiting for the timeout",
    (state) => {
      const test = setup({ statusBody: status(state, state === "error" ? "error" : null) });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(warehouseEnable({ ...flags, wait: true }));
        expect(Exit.findErrorOption(exit)).toEqual(
          Option.some(expect.objectContaining({ _tag: "WarehouseEnableIncompleteError" })),
        );
        expect(test.api.requests).toHaveLength(3);
      }).pipe(Effect.provide(test.layer));
    },
  );

  it.effect("rejects invalid timeout before contacting the project", () => {
    const test = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(warehouseEnable({ ...flags, timeout: "0" }));
      expect(Exit.findErrorOption(exit)).toEqual(
        Option.some(expect.objectContaining({ _tag: "WarehouseEnableInputError" })),
      );
      expect(test.api.requests).toHaveLength(0);
      expect(test.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(test.layer));
  });
});

describeHostedConsent("warehouse enable", {
  api: {
    handler: (request) =>
      Effect.succeed(
        jsonResponse(
          request,
          request.url.endsWith("/preview") ? 200 : 202,
          request.url.endsWith("/preview") ? preview : accepted,
        ),
      ),
  },
  invoke: ({ api }) => ({
    run: warehouseEnable(flags).pipe(Effect.provideService(OutputFlag, Option.none())),
    mutations: () => api.requests.filter((request) => request.url.endsWith("/setups")).length,
  }),
});
