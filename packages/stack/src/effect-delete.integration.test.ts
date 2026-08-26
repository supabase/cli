import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { deleteManagedStackPersistence as deleteWithNode } from "./effect-node.ts";
import { NoRunningStackError } from "./managed/model.ts";

const makeFixture = Effect.acquireRelease(
  Effect.try({
    try: () => {
      const root = mkdtempSync(join(tmpdir(), "stack-effect-delete-"));
      const workspace = join(root, "workspace");
      mkdirSync(workspace);
      return { root, workspace, cacheRoot: join(root, "cache") };
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }),
  ({ root }) =>
    Effect.try({
      try: () => rmSync(root, { recursive: true, force: true }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(Effect.ignore),
);

const assertDeleteWithoutStack = (deleteManagedStackPersistence: typeof deleteWithNode) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const error = yield* Effect.flip(
        deleteManagedStackPersistence({
          projectDir: fixture.workspace,
          cacheRoot: fixture.cacheRoot,
        }),
      );
      expect(error).toBeInstanceOf(NoRunningStackError);
    }),
  );

it.live("Node Effect entrypoint owns the complete delete transport", () =>
  assertDeleteWithoutStack(deleteWithNode),
);

it.live.skipIf(typeof Bun === "undefined")(
  "Bun Effect entrypoint owns the complete delete transport",
  () =>
    Effect.gen(function* () {
      const { deleteManagedStackPersistence } = yield* Effect.promise(
        () => import("./effect-bun.ts"),
      );
      yield* assertDeleteWithoutStack(deleteManagedStackPersistence);
    }),
);
