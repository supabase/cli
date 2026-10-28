import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { loadReport } from "./bench-summary.ts";

describe("loadReport", () => {
  it.effect("tells an absent report from an unreadable one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "bench-summary-" });
        const corrupt = `${dir}/report.json`;
        yield* fs.writeFileString(corrupt, "{ not a report");

        const absent = yield* loadReport(fs, `${dir}/missing.json`);
        const unreadable = yield* loadReport(fs, corrupt);

        expect(absent.report).toBeUndefined();
        expect(absent.notice).toContain("did not produce a report");
        expect(unreadable.report).toBeUndefined();
        expect(unreadable.notice).toContain("could not be read");
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  );
});
