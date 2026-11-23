import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Buffer } from "node:buffer";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Baseline, normalizeStdout } from "./machine-output.ts";
import { runCase } from "./scenario.ts";
import { scenarios } from "./scenarios.ts";

const binaryUrl = new URL(
  process.platform === "win32" ? "../../dist/supabase.exe" : "../../dist/supabase",
  import.meta.url,
);
const decodeBaseline = Schema.decodeUnknownEffect(Schema.fromJsonString(Baseline));

it.live("refuses to record a baseline in CI before processing arguments", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [fileURLToPath(import.meta.resolve("./record.ts"))], {
        extendEnv: false,
        env: { CI: "true", NO_COLOR: "1" },
      }),
    );
    const [code, stdout, stderr] = yield* Effect.all(
      [child.exitCode, Stream.runCollect(child.stdout), Stream.runCollect(child.stderr)],
      { concurrency: "unbounded" },
    );
    yield* Effect.annotateCurrentSpan({ "process.exit_code": code });
    expect(code).toBe(1);
    expect(Buffer.concat([...stdout, ...stderr]).toString("utf8")).toContain(
      "Baseline recording is local only; CI must verify.",
    );
  }).pipe(
    Effect.withSpan("MigrationCompat.checkRecorderCiGuard"),
    Effect.scoped,
    Effect.provide(BunServices.layer),
  ),
);

for (const scenario of scenarios) {
  it.live.each(scenario.cases)(
    `${scenario.name}: $name matches the pre-migration CLI`,
    (testCase) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baselinePath = yield* path.fromFileUrl(
          new URL(`${scenario.name}.baseline.json`, import.meta.url),
        );
        const baseline = yield* decodeBaseline(yield* fs.readFileString(baselinePath));
        expect(baseline.argv).toEqual(scenario.argv);
        expect(Object.keys(baseline.cases).sort()).toEqual(
          scenario.cases.map(({ name }) => name).sort(),
        );
        const expected = baseline.cases[testCase.name];
        if (!expected) return expect.fail(`Missing baseline for ${scenario.name}/${testCase.name}`);
        const actual = yield* runCase(yield* path.fromFileUrl(binaryUrl), scenario, testCase);
        expect(actual.exitCode).toBe(expected.exitCode);
        expect(normalizeStdout(testCase.format, actual.stdout)).toStrictEqual(
          normalizeStdout(testCase.format, expected.stdout),
        );
        expect(actual.stderr).toBe(expected.stderr);
      }).pipe(Effect.provide(BunServices.layer)),
  );
}
