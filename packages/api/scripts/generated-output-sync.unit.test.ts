import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import { describe, expect, test } from "vitest";

import { extractOperations, loadSpec, renderContracts, renderEffectClient } from "./generate.ts";

// Full-fidelity drift guard: re-renders every generated file from the
// committed openapi.json snapshot, formats the result through the same oxfmt
// the pipeline uses, and requires byte equality with the committed files.
// Unlike the operation-level bijection test in src/generated-contract-sync,
// this catches hand edits to schema definitions, parameter lists, request
// bodies, response types, and the executor switch — anything short of
// editing the snapshot and the generated output consistently, which the
// hourly upstream sync then catches.

const packageDirUrl = new URL("..", import.meta.url);
const generatedDirUrl = new URL("../src/generated/", import.meta.url);
const oxfmtBinUrl = new URL("../node_modules/.bin/oxfmt", import.meta.url);

const runPlatform = <A, E extends Error>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.orDie, Effect.provide(BunServices.layer)));

function formatWithOxfmt(source: string, fileName: string): Promise<string> {
  // oxfmt runs in file mode (also what the pipeline's fmt:fix runs) rather
  // than through stdin/stdout: Bun on Linux truncates a child's piped stdout
  // at ~219 KB, and these renders are 600+ KB. The temp directory lives
  // inside the package so oxfmt resolves the same configuration, but not
  // under node_modules, which oxfmt skips by default.
  return runPlatform(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const packageDir = yield* path.fromFileUrl(packageDirUrl);
      const oxfmtBin = yield* path.fromFileUrl(oxfmtBinUrl);
      const tempDir = yield* fs.makeTempDirectory({
        directory: packageDir,
        prefix: ".generated-output-sync-",
      });
      const tempFile = path.join(tempDir, fileName);
      yield* fs.writeFileString(tempFile, source);
      yield* spawner.string(ChildProcess.make(oxfmtBin, [tempFile], { cwd: packageDir }));
      const output = yield* fs.readFileString(tempFile);
      yield* fs.remove(tempDir, { recursive: true, force: true });
      return output;
    }),
  );
}

const committedFile = (fileName: string): Promise<string> =>
  runPlatform(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const generatedDir = yield* path.fromFileUrl(generatedDirUrl);
      return yield* fs.readFileString(path.join(generatedDir, fileName));
    }),
  );

function expectSameSource(rendered: string, committed: string, fileName: string): void {
  if (rendered === committed) {
    return;
  }
  const renderedLines = rendered.split("\n");
  const committedLines = committed.split("\n");
  const limit = Math.min(renderedLines.length, committedLines.length);
  let line = 0;
  while (line < limit && renderedLines[line] === committedLines[line]) {
    line += 1;
  }
  expect.fail(
    `src/generated/${fileName} is not what the generator renders from the committed snapshot ` +
      `(first difference at line ${line + 1}):\n` +
      `  committed: ${JSON.stringify(committedLines[line] ?? "<end of file>")}\n` +
      `  rendered:  ${JSON.stringify(renderedLines[line] ?? "<end of file>")}\n` +
      `Hand edits to src/generated are not allowed — run \`pnpm generate\` instead.`,
  );
}

// Rendering contracts.ts runs the real schema codegen for every operation,
// which takes well over vitest's default 5s budget.
const RENDER_TIMEOUT_MS = 120_000;

describe("generated output sync", () => {
  const document = loadSpec();
  const operations = extractOperations(document);

  test(
    "contracts.ts is byte-identical to the generator's render of the committed snapshot",
    { timeout: RENDER_TIMEOUT_MS },
    () => {
      return formatWithOxfmt(renderContracts(document, operations), "contracts.ts").then(
        (rendered) =>
          committedFile("contracts.ts").then((committed) =>
            expectSameSource(rendered, committed, "contracts.ts"),
          ),
      );
    },
  );

  test(
    "effect-client.ts is byte-identical to the generator's render of the committed snapshot",
    { timeout: RENDER_TIMEOUT_MS },
    () => {
      return formatWithOxfmt(renderEffectClient(operations), "effect-client.ts").then((rendered) =>
        committedFile("effect-client.ts").then((committed) =>
          expectSameSource(rendered, committed, "effect-client.ts"),
        ),
      );
    },
  );

  test(
    "openapi.json is byte-identical to the generator's normalized rewrite of itself",
    { timeout: RENDER_TIMEOUT_MS },
    () => {
      const encoded = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }))(
        document,
      );
      return formatWithOxfmt(`${encoded}\n`, "openapi.json").then((rendered) =>
        committedFile("openapi.json").then((committed) =>
          expectSameSource(rendered, committed, "openapi.json"),
        ),
      );
    },
  );
});
