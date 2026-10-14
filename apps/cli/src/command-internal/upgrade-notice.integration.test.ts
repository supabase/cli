import { stripVTControlCharacters } from "node:util";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Clock, DateTime, Effect, FileSystem, Layer, Path } from "effect";

import { withConfigEnv } from "../../tests/helpers/command-mocks.ts";
import { runtimeInfoLayer } from "../shared/runtime/runtime-info.layer.ts";
import { upgradeNoticeHook } from "./upgrade-notice.ts";

const captureStderr = <E, R>(body: Effect.Effect<void, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const written: Array<string> = [];
      const realWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      return { written, realWrite };
    }),
    ({ written }) => Effect.as(body, written),
    ({ realWrite }) =>
      Effect.sync(() => {
        process.stderr.write = realWrite;
      }),
  );

describe("upgrade notice user-level cache", () => {
  const userCache = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-upgrade-notice-home-" });
    const workdir = path.join(root, "outside-project");
    const supabaseHome = path.join(root, "supabase-home");
    yield* fs.makeDirectory(workdir);
    return { fs, workdir, supabaseHome, cacheFile: path.join(supabaseHome, "cli-latest") };
  });

  /** Ages the cache against the live clock, which the hook's freshness check reads. */
  const writeUserCache = Effect.fnUntraced(function* (
    { fs, supabaseHome, cacheFile }: Effect.Success<typeof userCache>,
    tag: string,
    ageMs: number,
  ) {
    yield* fs.makeDirectory(supabaseHome, { recursive: true });
    yield* fs.writeFileString(cacheFile, tag);
    const then = DateTime.toDateUtc(DateTime.makeUnsafe((yield* Clock.currentTimeMillis) - ageMs));
    yield* fs.utimes(cacheFile, then, then);
  });

  /** Runs the production hook with real `SUPABASE_HOME` resolution and a stub release fetch. */
  const runHook = Effect.fnUntraced(function* (
    { workdir, supabaseHome }: Effect.Success<typeof userCache>,
    latestTag: string,
  ) {
    let fetchCalls = 0;
    const written = yield* captureStderr(
      withConfigEnv(
        { SUPABASE_HOME: supabaseHome, SUPABASE_NO_UPDATE_NOTIFIER: "0" },
        upgradeNoticeHook(
          ["projects", "list"],
          {
            cleanShowHelp: false,
            delegatedToGo: false,
            workingDirectory: workdir,
            isValueTakingFlagToken: () => false,
          },
          Effect.sync(() => {
            fetchCalls += 1;
            return latestTag;
          }),
        ),
      ),
    );
    return { fetchCalls, stderr: stripVTControlCharacters(written.join("")) };
  });

  it.live("serves a fresh SUPABASE_HOME cache outside a project without fetching", () =>
    Effect.gen(function* () {
      const ctx = yield* userCache;
      yield* writeUserCache(ctx, "v99.99.99", 60_000);

      const { fetchCalls, stderr } = yield* runHook(ctx, "v99.99.100");

      expect(fetchCalls).toBe(0);
      expect(stderr).toContain("A new version of Supabase CLI is available: v99.99.99");
    }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer))),
  );

  it.live("refetches a stale SUPABASE_HOME cache and records the new tag", () =>
    Effect.gen(function* () {
      const ctx = yield* userCache;
      yield* writeUserCache(ctx, "v2.100.0", 11 * 60 * 60 * 1000);

      const { fetchCalls } = yield* runHook(ctx, "v99.99.100");

      expect(fetchCalls).toBe(1);
      expect(yield* ctx.fs.readFileString(ctx.cacheFile)).toBe("v99.99.100");
    }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer))),
  );
});
