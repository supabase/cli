import { afterEach, describe, expect, it } from "vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { createStack, type ForegroundStackHandle } from "./createStack.ts";
import { platformFactory } from "./platform-node.ts";
import { resolveConfig } from "./StackConfigResolver.ts";

const handles: ForegroundStackHandle[] = [];

afterEach(() => {
  const owned = handles.splice(0);
  return Effect.runPromise(Effect.forEach(owned, (handle) => handle.dispose(), { discard: true }));
});

describe("direct createStack port ownership", () => {
  it("allocates only active service fields without managed state", async () => {
    const stack = await Effect.runPromise(
      createStack(
        {
          mode: "native",
          postgrest: false,
          auth: false,
          edgeRuntime: false,
          realtime: false,
          storage: false,
          imgproxy: false,
          mailpit: false,
          pgmeta: false,
          studio: false,
          analytics: false,
          vector: false,
          pooler: false,
        },
        platformFactory,
        { mode: "native", containerRuntime: null },
        resolveConfig,
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    handles.push(stack);

    expect(stack.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(stack.dbUrl).toMatch(/127\.0\.0\.1:\d+/);
    const activeServices = new Set(
      (await Effect.runPromise(stack.getStatus())).map((state) => state.name),
    );
    expect(activeServices).not.toContain("studio");
    expect(activeServices).not.toContain("analytics");
    expect(activeServices).not.toContain("pooler");
  });
});
