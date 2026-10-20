import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";

import { stripAnsi } from "../../tests/helpers/ansi.ts";
import { VALID_REF, mockCommandSettings } from "../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../tests/helpers/mocks.ts";
import { targetDefaultWarning } from "../../tests/helpers/target-default-warning.ts";
import { warnLinkedTargetDefault } from "./target-default-warning.ts";

interface Scenario {
  readonly projectId?: Option.Option<string>;
  readonly refFile?: string;
  readonly refPathIsDirectory?: boolean;
}

const run = (input: Parameters<typeof warnLinkedTargetDefault>[0], scenario: Scenario = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "target-warning-" });
    const refPath = path.join(workdir, "supabase", ".temp", "project-ref");
    if (scenario.refFile !== undefined) {
      yield* fs.makeDirectory(path.dirname(refPath), { recursive: true });
      yield* fs.writeFileString(refPath, scenario.refFile);
    }
    if (scenario.refPathIsDirectory === true) {
      yield* fs.makeDirectory(refPath, { recursive: true });
    }
    const out = mockOutput();
    yield* warnLinkedTargetDefault(input).pipe(
      Effect.provide(
        Layer.mergeAll(
          out.layer,
          mockCommandSettings({ workdir, projectId: scenario.projectId ?? Option.none() }),
          BunServices.layer,
        ),
      ),
    );
    return { stdout: out.stdoutText, stderr: stripAnsi(out.stderrText) };
  }).pipe(Effect.provide(BunServices.layer));

const BARE = { command: "db push", targetSelected: false } as const;
const WARNING = `${targetDefaultWarning("db push")}\n`;

describe("warnLinkedTargetDefault", () => {
  it.effect("warns once on stderr when SUPABASE_PROJECT_ID configures the linked project", () =>
    Effect.gen(function* () {
      const result = yield* run(BARE, { projectId: Option.some(VALID_REF) });
      expect(result).toEqual({ stdout: "", stderr: WARNING });
    }),
  );

  it.effect("warns when only the link file configures the linked project", () =>
    Effect.gen(function* () {
      const result = yield* run(BARE, { refFile: `${VALID_REF}\n` });
      expect(result).toEqual({ stdout: "", stderr: WARNING });
    }),
  );

  it.effect("stays silent when neither SUPABASE_PROJECT_ID nor the link file is configured", () =>
    Effect.gen(function* () {
      const result = yield* run(BARE);
      expect(result).toEqual({ stdout: "", stderr: "" });
    }),
  );

  it.effect("stays silent when the link file is blank", () =>
    Effect.gen(function* () {
      const result = yield* run(BARE, { refFile: "  \n" });
      expect(result.stderr).toBe("");
    }),
  );

  it.effect("stays silent when the link file cannot be read", () =>
    Effect.gen(function* () {
      const result = yield* run(BARE, { refPathIsDirectory: true });
      expect(result.stderr).toBe("");
    }),
  );

  it.effect("stays silent when a target selector was passed, even with a linked project", () =>
    Effect.gen(function* () {
      const result = yield* run(
        { command: "db push", targetSelected: true },
        { projectId: Option.some(VALID_REF), refFile: VALID_REF },
      );
      expect(result.stderr).toBe("");
    }),
  );

  it.effect("warns when the caller already resolved the ref and nothing is configured", () =>
    Effect.gen(function* () {
      const result = yield* run({ ...BARE, linkedRefResolved: true });
      expect(result).toEqual({ stdout: "", stderr: WARNING });
    }),
  );

  it.effect("stays silent for a resolved ref when a target selector was passed", () =>
    Effect.gen(function* () {
      const result = yield* run({
        command: "db push",
        targetSelected: true,
        linkedRefResolved: true,
      });
      expect(result.stderr).toBe("");
    }),
  );

  it.effect("names the local target the caller supplies", () =>
    Effect.gen(function* () {
      const result = yield* run(
        { command: "storage ls", targetSelected: false, localTarget: "the local Storage API" },
        { projectId: Option.some(VALID_REF) },
      );
      expect(result.stderr).toBe(
        `${targetDefaultWarning("storage ls", "the local Storage API")}\n`,
      );
    }),
  );
});
