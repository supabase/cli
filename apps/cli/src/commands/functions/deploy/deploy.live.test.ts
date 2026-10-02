import { randomUUID } from "node:crypto";

import { BunServices } from "@effect/platform-bun";
import { Cause, Data, Effect, Exit, FileSystem, Path } from "effect";
import { expect } from "vitest";
import { describe } from "vitest";

import {
  expectFunctionOk,
  type LiveFixtures,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

type LiveCliEffect = LiveFixtures["cliEffect"];

class FunctionsDeployLiveError extends Data.TaggedError("FunctionsDeployLiveError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function cleanupFunction(cliEffect: LiveCliEffect, slug: string, ref: string) {
  return Effect.gen(function* () {
    const deleted = yield* cliEffect(["functions", "delete", slug, "--project-ref", ref]);
    if (
      deleted.exitCode !== 0 &&
      !/not found|does not exist/i.test(`${deleted.stdout}\n${deleted.stderr}`)
    ) {
      return yield* new FunctionsDeployLiveError({
        message: `functions delete cleanup failed:\n${deleted.stdout}\n${deleted.stderr}`,
      });
    }
  });
}

function codeSafeJson(value: string) {
  return JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

describe("functions deploy (live)", () => {
  test("deploys a function that responds over HTTP", ({ cliEffect, invoke, project, workspace }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const slug = `cli-e2e-deploy-${randomUUID().slice(0, 8)}`;
        const directory = path.join(workspace.path, "supabase", "functions", slug);
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(
          path.join(directory, "index.ts"),
          `Deno.serve(() => Response.json({ case: ${codeSafeJson(slug)}, ok: true }));\n`,
        );
        yield* fs.writeFileString(path.join(directory, "deno.json"), '{\n  "imports": {}\n}\n');

        const target = Effect.gen(function* () {
          const result = yield* cliEffect(["functions", "deploy", "--project-ref", project.ref]);
          expect(result.exitCode, result.stderr).toBe(0);
          expect(result.stdout).toMatch(/Deployed Function/i);

          const invoked = yield* Effect.tryPromise({
            try: () => invoke(slug),
            catch: (cause) =>
              new FunctionsDeployLiveError({ message: `functions invoke ${slug} failed`, cause }),
          });
          expectFunctionOk(invoked, slug);
        });

        const targetExit = yield* Effect.exit(target);
        const cleanupExit = yield* Effect.exit(cleanupFunction(cliEffect, slug, project.ref));
        return {
          targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
          cleanupErrors: Exit.isFailure(cleanupExit) ? [Cause.squash(cleanupExit.cause)] : [],
        };
      }).pipe(Effect.provide(BunServices.layer)),
    ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)));
});
