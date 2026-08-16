import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Option } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import type {
  LegacyShadowBaselinePeek,
  LegacyShadowCacheKeyInputs,
} from "../../../shared/db-bootstrap/shadow-cache.ts";
import {
  legacyBufferedShadowOutput,
  legacyResolvePlanShadowStrategy,
  legacyRunPlanShadowProvisions,
} from "./legacy-pgdelta-next-shadow.plan.ts";

const keyInputs = (): LegacyShadowCacheKeyInputs => ({
  postgresImage: "public.ecr.aws/supabase/postgres:17.6.1.158",
  majorVersion: 17,
  jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
  jwtExpiry: 3600,
  rootKey: "d4dc5b6d4a1d6a10b2c1e5b6a7c8d9e0",
  dbPassword: "postgres",
  dbSettings: {},
  autoExposeNewTables: Option.none(),
  storageTargetMigration: "",
  webhooksEnabled: false,
  rolesSql: "",
  vault: [],
  jwks: "",
  services: {
    realtime: { enabled: false, image: "" },
    storage: { enabled: false, image: "" },
    auth: { enabled: false, image: "" },
  },
});

const warm = (key: string): LegacyShadowBaselinePeek => ({
  state: "warm",
  key,
  keyInputs: keyInputs(),
});
const cold = (key: string): LegacyShadowBaselinePeek => ({
  state: "cold",
  key,
  keyInputs: keyInputs(),
});
const uncachable: LegacyShadowBaselinePeek = { state: "uncachable" };

describe("legacyResolvePlanShadowStrategy", () => {
  it("runs two published snapshots in parallel", () => {
    expect(legacyResolvePlanShadowStrategy(warm("k"), warm("k"))).toBe("parallel");
    // Two warm tars under different keys restore independently — still parallel.
    expect(legacyResolvePlanShadowStrategy(warm("a"), warm("b"))).toBe("parallel");
  });

  it("hands the baseline off when both are cold under one key", () => {
    expect(legacyResolvePlanShadowStrategy(cold("k"), cold("k"))).toBe("baseline-handoff");
  });

  it("falls back to sequential when no baseline can be shared", () => {
    expect(legacyResolvePlanShadowStrategy(cold("a"), cold("b"))).toBe("sequential");
    expect(legacyResolvePlanShadowStrategy(warm("a"), cold("b"))).toBe("sequential");
    expect(legacyResolvePlanShadowStrategy(cold("a"), warm("b"))).toBe("sequential");
    expect(legacyResolvePlanShadowStrategy(uncachable, uncachable)).toBe("sequential");
    expect(legacyResolvePlanShadowStrategy(uncachable, cold("k"))).toBe("sequential");
    expect(legacyResolvePlanShadowStrategy(warm("k"), uncachable)).toBe("sequential");
  });
});

describe("legacyRunPlanShadowProvisions", () => {
  it.effect("parallel: both provisions overlap in flight", () =>
    Effect.gen(function* () {
      const log: string[] = [];
      // Each side blocks until the other has started — this completes only under real
      // concurrency; a sequential runner would deadlock (and trip the test timeout).
      const migrationsStarted = yield* Deferred.make<void>();
      const declarativeStarted = yield* Deferred.make<void>();
      const [migrations, declarative] = yield* legacyRunPlanShadowProvisions({
        strategy: "parallel",
        provisionMigrations: () =>
          Effect.gen(function* () {
            log.push("migrations:start");
            yield* Deferred.succeed(migrationsStarted, undefined);
            yield* Deferred.await(declarativeStarted);
            log.push("migrations:done");
            return "m" as const;
          }),
        provisionDeclarative: Effect.gen(function* () {
          log.push("declarative:start");
          yield* Deferred.succeed(declarativeStarted, undefined);
          yield* Deferred.await(migrationsStarted);
          log.push("declarative:done");
          return "d" as const;
        }),
      });
      expect(migrations).toBe("m");
      expect(declarative).toBe("d");
      expect(log.slice(0, 2).sort()).toEqual(["declarative:start", "migrations:start"]);
    }),
  );

  it.effect(
    "baseline-handoff: declarative starts only after the seam, concurrent with the replay",
    () =>
      Effect.gen(function* () {
        const log: string[] = [];
        // The migrations side stays in "replay" until the declarative side has finished —
        // proving the declarative provision ran BETWEEN the seam and the replay's end (i.e.
        // concurrently with the replay), not after the whole migrations provision.
        const declarativeDone = yield* Deferred.make<void>();
        yield* legacyRunPlanShadowProvisions({
          strategy: "baseline-handoff",
          provisionMigrations: (onBaselineSeam) =>
            Effect.gen(function* () {
              log.push("migrations:baseline");
              yield* onBaselineSeam;
              log.push("migrations:replay");
              yield* Deferred.await(declarativeDone);
              log.push("migrations:done");
              return "m" as const;
            }),
          provisionDeclarative: Effect.gen(function* () {
            log.push("declarative:start");
            yield* Deferred.succeed(declarativeDone, undefined);
            return "d" as const;
          }),
        });
        expect(log.indexOf("declarative:start")).toBeGreaterThan(
          log.indexOf("migrations:baseline"),
        );
        expect(log.indexOf("declarative:start")).toBeLessThan(log.indexOf("migrations:done"));
      }),
  );

  it.effect(
    "baseline-handoff: a provision that never reaches the seam still releases the waiter",
    () =>
      Effect.gen(function* () {
        const log: string[] = [];
        const [migrations, declarative] = yield* legacyRunPlanShadowProvisions({
          strategy: "baseline-handoff",
          // Ignores `onBaselineSeam` entirely — a warm-raced or uncached acquire never runs a
          // snapshot. The runner's own `Effect.ensuring` backstop must fire the signal when
          // the provision ends, or the declarative waiter deadlocks.
          provisionMigrations: () =>
            Effect.sync(() => {
              log.push("migrations");
              return "m" as const;
            }),
          provisionDeclarative: Effect.sync(() => {
            log.push("declarative");
            return "d" as const;
          }),
        });
        expect(migrations).toBe("m");
        expect(declarative).toBe("d");
        expect(log).toEqual(["migrations", "declarative"]);
      }),
  );

  it.effect("baseline-handoff: a pre-seam failure interrupts the waiter instead of hanging", () =>
    Effect.gen(function* () {
      let declarativeRan = false;
      const exit = yield* legacyRunPlanShadowProvisions({
        strategy: "baseline-handoff",
        provisionMigrations: () => Effect.fail("baseline exploded" as const),
        provisionDeclarative: Effect.sync(() => {
          declarativeRan = true;
          return "d" as const;
        }),
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(declarativeRan).toBe(false);
    }),
  );

  it.effect("sequential: declarative starts only after migrations completes", () =>
    Effect.gen(function* () {
      const log: string[] = [];
      yield* legacyRunPlanShadowProvisions({
        strategy: "sequential",
        provisionMigrations: () =>
          Effect.sync(() => {
            log.push("migrations");
            return "m" as const;
          }),
        provisionDeclarative: Effect.sync(() => {
          log.push("declarative");
          return "d" as const;
        }),
      });
      expect(log).toEqual(["migrations", "declarative"]);
    }),
  );
});

describe("legacyBufferedShadowOutput", () => {
  it.effect("holds writes until flush, then replays them after the live lines", () => {
    const out = mockOutput();
    return Effect.gen(function* () {
      const real = yield* Output;
      const buffered = legacyBufferedShadowOutput(real);
      // Simulates the parallel window: the buffered fiber's lines arrive in TIME between the
      // live fiber's lines, but the flushed transcript keeps each fiber's block contiguous.
      yield* real.raw("Applying migration a...\n", "stderr");
      yield* buffered.output.raw("Initialising schema...\n", "stderr");
      yield* real.raw("Applying migration b...\n", "stderr");
      yield* buffered.output.raw("Seeding globals from roles.sql...\n", "stderr");
      yield* buffered.flush;
      expect(out.rawChunks.map((chunk) => chunk.text)).toEqual([
        "Applying migration a...\n",
        "Applying migration b...\n",
        "Initialising schema...\n",
        "Seeding globals from roles.sql...\n",
      ]);
    }).pipe(Effect.provide(out.layer));
  });

  it.effect("flush is idempotent and later writes pass straight through", () => {
    const out = mockOutput();
    return Effect.gen(function* () {
      const real = yield* Output;
      const buffered = legacyBufferedShadowOutput(real);
      yield* buffered.output.raw("buffered\n", "stderr");
      yield* buffered.flush;
      yield* buffered.flush;
      // A teardown warning arriving after the flush must not be swallowed.
      yield* buffered.output.raw("late warning\n", "stderr");
      expect(out.rawChunks.map((chunk) => chunk.text)).toEqual(["buffered\n", "late warning\n"]);
    }).pipe(Effect.provide(out.layer));
  });

  it.effect("buffers rawBytes alongside raw, preserving arrival order and streams", () => {
    const out = mockOutput();
    return Effect.gen(function* () {
      const real = yield* Output;
      const buffered = legacyBufferedShadowOutput(real);
      yield* buffered.output.raw("first\n", "stderr");
      yield* buffered.output.rawBytes(new TextEncoder().encode("second\n"), "stderr");
      yield* buffered.flush;
      expect(out.rawChunks).toEqual([
        { text: "first\n", stream: "stderr" },
        { text: "second\n", stream: "stderr" },
      ]);
    }).pipe(Effect.provide(out.layer));
  });
});
