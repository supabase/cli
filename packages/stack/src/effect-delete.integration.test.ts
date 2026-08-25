import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import {
  deleteManagedStackPersistence as deleteWithBun,
  StackRpcProtocolError as BunStackRpcProtocolError,
  StackRpcTransportError as BunStackRpcTransportError,
} from "./effect-bun.ts";
import {
  deleteManagedStackPersistence as deleteWithNode,
  StackRpcProtocolError as NodeStackRpcProtocolError,
  StackRpcTransportError as NodeStackRpcTransportError,
} from "./effect-node.ts";
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

for (const [runtime, deleteManagedStackPersistence] of [
  ["Bun", deleteWithBun],
  ["Node", deleteWithNode],
] as const) {
  it.live(`${runtime} Effect entrypoint owns the complete delete transport`, () =>
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
    ),
  );
}

for (const [runtime, StackRpcProtocolError, StackRpcTransportError] of [
  ["Bun", BunStackRpcProtocolError, BunStackRpcTransportError],
  ["Node", NodeStackRpcProtocolError, NodeStackRpcTransportError],
] as const) {
  it(`${runtime} Effect entrypoint exports its public RPC failures`, () => {
    expect(StackRpcProtocolError).toBeTypeOf("function");
    expect(StackRpcTransportError).toBeTypeOf("function");
  });
}
