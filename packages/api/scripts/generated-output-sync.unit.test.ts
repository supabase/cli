import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path } from "effect";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { describe, expect, test } from "vitest";

import {
  extractOperations,
  loadSpec,
  renderContracts,
  renderEffectClient,
  renderOpenApiJson,
  renderPermissions,
} from "./generate.ts";

// Full-fidelity drift guard: re-renders every generated file from the committed
// snapshot, formats it with the same oxfmt the pipeline uses, and requires byte
// equality. Catches hand edits to schema definitions, parameter lists, request
// bodies, response types, and the executor switch, which the operation-level
// bijection test in src/generated-contract-sync doesn't.

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const repoDir = fileURLToPath(new URL("../../..", import.meta.url));
const generatedDir = fileURLToPath(new URL("../src/generated", import.meta.url));
// oxfmt is a repo-root devDependency configured by the root .oxfmtrc.json,
// which is also how the pipeline's root fmt:fix target runs it.
const oxfmtBin = fileURLToPath(new URL("../../../node_modules/.bin/oxfmt", import.meta.url));
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

const formatWithOxfmt = (source: string, fileName: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner;
    // Runs oxfmt in file mode, not via stdin/stdout: Bun on Linux truncates a
    // child's piped stdout at ~219 KB, and these renders are 600+ KB. The temp
    // dir lives inside the package (same oxfmt config) but outside node_modules,
    // which oxfmt skips by default.
    const tempDir = yield* fs.makeTempDirectoryScoped({
      directory: packageDir,
      prefix: ".generated-output-sync-",
    });
    const tempFile = path.join(tempDir, fileName);
    yield* fs.writeFileString(tempFile, source);
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make(oxfmtBin, [tempFile], {
        cwd: repoDir,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "inherit",
      }),
    );
    if (exitCode !== 0) {
      return yield* Effect.die(`oxfmt exited with code ${exitCode} for ${tempFile}`);
    }
    return utf8.decode(yield* fs.readFile(tempFile));
  }).pipe(Effect.scoped);

const committedFile = (fileName: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return utf8.decode(yield* fs.readFile(path.join(generatedDir, fileName)));
  });

const expectSameSource = (rendered: string, fileName: string) =>
  Effect.map(committedFile(fileName), (committed) => {
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
  });

// Rendering contracts.ts runs the real schema codegen for every operation,
// which takes well over vitest's default 5s budget.
const RENDER_TIMEOUT_MS = 120_000;

const document = await Effect.runPromise(loadSpec.pipe(Effect.provide(NodeServices.layer)));

describe("generated output sync", () => {
  const operations = extractOperations(document);

  test(
    "contracts.ts is byte-identical to the generator's render of the committed snapshot",
    { timeout: RENDER_TIMEOUT_MS },
    () =>
      formatWithOxfmt(renderContracts(document, operations), "contracts.ts").pipe(
        Effect.flatMap((formatted) => expectSameSource(formatted, "contracts.ts")),
        Effect.provide(NodeServices.layer),
        Effect.runPromise,
      ),
  );

  test(
    "effect-client.ts is byte-identical to the generator's render of the committed snapshot",
    { timeout: RENDER_TIMEOUT_MS },
    () =>
      formatWithOxfmt(renderEffectClient(operations), "effect-client.ts").pipe(
        Effect.flatMap((formatted) => expectSameSource(formatted, "effect-client.ts")),
        Effect.provide(NodeServices.layer),
        Effect.runPromise,
      ),
  );

  test(
    "permissions.ts is byte-identical to the generator's render of the committed snapshot",
    { timeout: RENDER_TIMEOUT_MS },
    () =>
      formatWithOxfmt(renderPermissions(document), "permissions.ts").pipe(
        Effect.flatMap((formatted) => expectSameSource(formatted, "permissions.ts")),
        Effect.provide(NodeServices.layer),
        Effect.runPromise,
      ),
  );

  test(
    "openapi.json is byte-identical to the generator's normalized rewrite of itself",
    { timeout: RENDER_TIMEOUT_MS },
    () =>
      renderOpenApiJson(document).pipe(
        Effect.flatMap((json) => formatWithOxfmt(json, "openapi.json")),
        Effect.flatMap((formatted) => expectSameSource(formatted, "openapi.json")),
        Effect.provide(NodeServices.layer),
        Effect.runPromise,
      ),
  );
});
