import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { CommandPlatformApi } from "../../auth/command-platform-api.service.ts";
import { CommandPlatformApiFactory } from "../../auth/command-platform-api-factory.service.ts";
import {
  makeComputeProject,
  setupCompute,
  COMPUTE_PROJECT_REF,
} from "../../../tests/helpers/compute.ts";
import { makeRemoteLogsSession } from "./logs.remote-session.ts";
import type { LogsFlags } from "./logs.session.ts";

const now = Date.parse("2026-11-04T12:00:00Z");
const route = `GET /v1/projects/${COMPUTE_PROJECT_REF}/analytics/endpoints/logs`;
const flags = (overrides: Partial<LogsFlags> = {}): LogsFlags => ({
  remote: Option.some({ _tag: "Linked" }),
  projectRef: Option.none(),
  local: false,
  linked: false,
  stack: Option.none(),
  stackId: Option.none(),
  service: ["postgres"],
  resource: Option.none(),
  kind: Option.none(),
  level: [],
  search: Option.none(),
  since: Option.none(),
  from: Option.none(),
  to: Option.none(),
  sql: Option.none(),
  file: Option.none(),
  limit: 100,
  ...overrides,
});
const row = (id: string, ts_ms = now) => ({
  id,
  ts_ms,
  source: "postgres_logs",
  severity_text: "INFO",
  level: "info",
  event_message: id,
  log_attributes: {},
});
const page = (rows: ReadonlyArray<Schema.JsonObject>) => ({
  status: 200,
  body: { result: rows, error: null },
});
const prepare = Effect.fnUntraced(function* (
  options: Parameters<typeof setupCompute>[0],
  optionsFlags: LogsFlags = flags(),
  sql?: string,
) {
  const setup = setupCompute(options);
  const api = yield* CommandPlatformApi.pipe(Effect.provide(setup.layer));
  const session = yield* makeRemoteLogsSession(
    optionsFlags,
    COMPUTE_PROJECT_REF,
    now,
    false,
    sql,
  ).pipe(Effect.provideService(CommandPlatformApiFactory, { make: Effect.succeed(api) }));
  return { ...setup, session };
});

it.effect(
  "drains every refresh page with exact millisecond/id ordering and deduplicates overlap independently of displayed rows",
  () =>
    Effect.gen(function* () {
      const repo = yield* makeComputeProject();
      const old = row("initial", now - 1000);
      const fresh = Array.from({ length: 1500 }, (_, index) =>
        row(`id-${String(index).padStart(4, "0")}`),
      );
      const setup = yield* prepare({
        workdir: repo.dir,
        routes: {
          [route]: [
            page([old]),
            page([old, ...fresh.slice(0, 999)]),
            page(fresh.slice(999)),
            page(fresh.slice(0, 1000)),
            page(fresh.slice(1000)),
          ],
        },
      });
      yield* setup.session.load(now, () => Effect.void);
      const loaded: Schema.JsonObject[] = [];
      const window = yield* setup.session.load(now + 10000, (item) =>
        Effect.sync(() => {
          loaded.push(item);
        }),
      );
      expect(loaded.map((item) => item["id"])).toEqual(fresh.map((item) => item.id));
      expect(window).toEqual({
        kind: "range",
        start: "2026-11-04T11:00:00.000Z",
        end: "2026-11-04T12:00:10.000Z",
      });
      expect(setup.http.requests[1]?.urlParams.sql).toContain(
        "order by ts_ms asc, id asc limit 1000",
      );
      expect(setup.http.requests[2]?.urlParams.sql).toContain(
        "toUnixTimestamp64Milli(timestamp) = 1793793600000 and id > 'id-0998'",
      );
      expect(
        setup.http.requests.slice(1).map((request) => request.urlParams.iso_timestamp_end),
      ).toEqual(["2026-11-04T12:00:10.000Z", "2026-11-04T12:00:10.000Z"]);
      const repeated: Schema.JsonObject[] = [];
      yield* setup.session.load(now + 20000, (item) =>
        Effect.sync(() => {
          repeated.push(item);
        }),
      );
      expect(repeated).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);

it.effect("includes late older overlap rows when the initial history was not truncated", () =>
  Effect.gen(function* () {
    const repo = yield* makeComputeProject();
    const setup = yield* prepare({
      workdir: repo.dir,
      routes: {
        [route]: [
          page([row("first", now - 1000)]),
          page([row("late", now - 5000), row("first", now - 1000)]),
        ],
      },
    });
    yield* setup.session.load(now, () => Effect.void);
    const loaded: Schema.JsonObject[] = [];
    yield* setup.session.load(now + 1000, (item) =>
      Effect.sync(() => {
        loaded.push(item);
      }),
    );
    expect(loaded.map((item) => item["id"])).toEqual(["late"]);
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);

it.effect("keeps a failed refresh checkpoint unchanged so retry rereads all pages", () =>
  Effect.gen(function* () {
    const repo = yield* makeComputeProject();
    const fresh = Array.from({ length: 1000 }, (_, index) =>
      row(`id-${String(index).padStart(4, "0")}`),
    );
    const setup = yield* prepare({
      workdir: repo.dir,
      routes: {
        [route]: [
          page([row("old", now - 1000)]),
          page(fresh),
          { status: 500 },
          page(fresh),
          page([row("last", now + 1000)]),
        ],
      },
    });
    yield* setup.session.load(now, () => Effect.void);
    const error = yield* setup.session.load(now + 10000, () => Effect.void).pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "LogsApiError", status: 500 });
    const retried: Schema.JsonObject[] = [];
    yield* setup.session.load(now + 10000, (item) =>
      Effect.sync(() => {
        retried.push(item);
      }),
    );
    expect(retried).toHaveLength(1001);
    expect(retried.at(-1)?.["id"]).toBe("last");
    expect(setup.http.requests[3]?.urlParams).toEqual(setup.http.requests[1]?.urlParams);
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);

it.effect(
  "reruns custom SQL without rewriting it and extends the requested end monotonically",
  () =>
    Effect.gen(function* () {
      const repo = yield* makeComputeProject();
      const sql = "select count() as total from logs order by total desc";
      const setup = yield* prepare(
        { workdir: repo.dir, routes: { [route]: [page([{ total: 2 }]), page([{ total: 3 }])] } },
        flags({ service: [], to: Option.some("2026-11-04T11:55:00Z") }),
        sql,
      );
      expect(setup.session.mode).toBe("replace");
      yield* setup.session.load(now, () => Effect.void);
      const rows: Schema.JsonObject[] = [];
      const window = yield* setup.session.load(now + 10000, (item) =>
        Effect.sync(() => {
          rows.push(item);
        }),
      );
      expect(rows).toEqual([{ total: 3 }]);
      expect(window).toEqual({
        kind: "range",
        start: "2026-11-04T11:00:00.000Z",
        end: "2026-11-04T12:00:10.000Z",
      });
      expect(setup.http.requests.map((request) => request.urlParams.sql)).toEqual([sql, sql]);
      expect(setup.http.requests[0]?.urlParams.iso_timestamp_end).toBe("2026-11-04T11:55:00.000Z");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);
