import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
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
        start: "2026-11-04T10:55:00.000Z",
        end: "2026-11-04T12:00:10.000Z",
      });
      expect(setup.http.requests.map((request) => request.urlParams.sql)).toEqual([sql, sql]);
      expect(setup.http.requests[0]?.urlParams.iso_timestamp_end).toBe("2026-11-04T11:55:00.000Z");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);

it.effect("caps refresh pages and resumes a fixed window at an exact tied-timestamp cursor", () =>
  Effect.gen(function* () {
    const repo = yield* makeComputeProject();
    const fresh = Array.from({ length: 6001 }, (_, index) =>
      row(`id-${String(index).padStart(5, "0")}`),
    );
    const setup = yield* prepare({
      workdir: repo.dir,
      routes: {
        [route]: [
          page([row("old", now - 1000)]),
          ...Array.from({ length: 5 }, (_, index) =>
            page(fresh.slice(index * 1000, (index + 1) * 1000)),
          ),
          { status: 500 },
          page(fresh.slice(5000, 6000)),
          page(fresh.slice(6000)),
          page([row("old", now - 1000), ...fresh.slice(0, 998)]),
        ],
      },
    });
    yield* setup.session.load(now, () => Effect.void);
    const rows: Schema.JsonObject[] = [];
    const emit = (item: Schema.JsonObject) =>
      Effect.sync(() => {
        rows.push(item);
      });
    const partial = yield* setup.session.load(now + 10000, emit);
    expect(rows).toHaveLength(5000);
    expect(partial).toMatchObject({ end: "2026-11-04T12:00:10.000Z", pending: true });
    expect((yield* setup.session.load(now + 90000, emit).pipe(Effect.exit))._tag).toBe("Failure");
    expect(rows).toHaveLength(5000);
    const complete = yield* setup.session.load(now + 95000, emit);
    expect(setup.http.requests[7]?.urlParams).toEqual(setup.http.requests[6]?.urlParams);
    expect(complete).toMatchObject({ end: "2026-11-04T12:00:10.000Z" });
    expect(complete).not.toMatchObject({ pending: true });
    expect(rows.map(({ id }) => id)).toEqual(fresh.map(({ id }) => id));
    expect(setup.http.requests[6]?.urlParams.sql).toContain("id > 'id-04999'");
    expect(setup.http.requests[6]?.urlParams.iso_timestamp_end).toBe("2026-11-04T12:00:10.000Z");
    rows.length = 0;
    yield* setup.session.load(now + 100000, emit);
    expect(rows).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);

it.effect("retries only the throttled page after its retry-after delay", () =>
  Effect.gen(function* () {
    const repo = yield* makeComputeProject();
    const full = Array.from({ length: 1000 }, (_, index) =>
      row(`id-${String(index).padStart(4, "0")}`),
    );
    const setup = yield* prepare({
      workdir: repo.dir,
      routes: {
        [route]: [
          page([row("old", now - 1000)]),
          page(full),
          { status: 429, headers: { "retry-after": "90" } },
          page([row("last", now + 1)]),
        ],
      },
    });
    yield* setup.session.load(now, () => Effect.void);
    const rows: Schema.JsonObject[] = [];
    const firstPage = yield* Deferred.make<void>();
    const fiber = yield* setup.session
      .load(now + 10000, (item) =>
        Effect.gen(function* () {
          rows.push(item);
          if (rows.length === 1000) yield* Deferred.succeed(firstPage, undefined);
        }),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(firstPage);
    yield* TestClock.adjust("89 seconds");
    expect(setup.http.requests).toHaveLength(3);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(fiber);
    expect(rows.map(({ id }) => id)).toEqual([...full.map(({ id }) => id), "last"]);
    expect(setup.http.requests).toHaveLength(4);
    expect(setup.http.requests[3]?.urlParams).toEqual(setup.http.requests[2]?.urlParams);
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);

it.effect("selects only severity-supported sources when level is the only filter", () =>
  Effect.gen(function* () {
    const repo = yield* makeComputeProject();
    const setup = yield* prepare(
      { workdir: repo.dir, routes: { [route]: page([row("error")]) } },
      flags({ service: [], level: ["error"] }),
    );
    const rows: Schema.JsonObject[] = [];
    yield* setup.session.load(now, (item) =>
      Effect.sync(() => {
        rows.push(item);
      }),
    );
    const sql = setup.http.requests[0]?.urlParams.sql ?? "";
    expect(sql).toContain("source = 'postgres_logs'");
    expect(sql).toContain("source = 'function_edge_logs'");
    expect(sql).not.toContain("source = 'storage_logs'");
    expect(rows[0]).toMatchObject({ service: "postgres", source: "postgres_logs" });
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);

it.effect("uses the retry time after an initial request failure", () =>
  Effect.gen(function* () {
    const repo = yield* makeComputeProject();
    const setup = yield* prepare({
      workdir: repo.dir,
      routes: { [route]: [{ status: 500 }, page([row("retry", now + 5000)])] },
    });
    expect((yield* setup.session.load(now, () => Effect.void).pipe(Effect.exit))._tag).toBe(
      "Failure",
    );
    expect(yield* setup.session.load(now + 10000, () => Effect.void)).toMatchObject({
      end: "2026-11-04T12:00:10.000Z",
    });
    expect(setup.http.requests[1]?.urlParams.iso_timestamp_end).toBe("2026-11-04T12:00:10.000Z");
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);

it.effect("exhausts one retry per throttled page and leaves its checkpoint unchanged", () =>
  Effect.gen(function* () {
    const repo = yield* makeComputeProject();
    const setup = yield* prepare({
      workdir: repo.dir,
      routes: {
        [route]: [
          page([row("old", now - 1)]),
          { status: 429 },
          { status: 429 },
          page([row("after retry", now + 1)]),
        ],
      },
    });
    yield* setup.session.load(now, () => Effect.void);
    const fiber = yield* setup.session
      .load(now + 1000, () => Effect.void)
      .pipe(Effect.exit, Effect.forkScoped);
    yield* TestClock.adjust("60 seconds");
    expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "Failure" });
    expect(setup.http.requests).toHaveLength(3);
    const rows: Schema.JsonObject[] = [];
    yield* setup.session.load(now + 1000, (row) =>
      Effect.sync(() => {
        rows.push(row);
      }),
    );
    expect(rows.map(({ id }) => id)).toEqual(["after retry"]);
    expect(setup.http.requests[3]?.urlParams).toEqual(setup.http.requests[1]?.urlParams);
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);

it.effect("interrupts a throttled page without waiting for its scheduled retry", () =>
  Effect.gen(function* () {
    const repo = yield* makeComputeProject();
    const setup = yield* prepare({
      workdir: repo.dir,
      routes: { [route]: [page([row("old", now - 1)]), { status: 429 }] },
    });
    yield* setup.session.load(now, () => Effect.void);
    const fiber = yield* setup.session.load(now + 1000, () => Effect.void).pipe(Effect.forkScoped);
    yield* TestClock.adjust("59 seconds");
    yield* Fiber.interrupt(fiber);
    yield* TestClock.adjust("120 seconds");
    expect(setup.http.requests).toHaveLength(2);
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);
