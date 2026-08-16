import { afterEach, describe, expect, it } from "vitest";
import { createStack, type StackHandle } from "./createStack.ts";
import { platformFactory } from "./platform-node.ts";

const handles: StackHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.dispose()));
});

describe("direct createStack port ownership", () => {
  it("allocates only active service fields without managed state", async () => {
    const stack = await createStack(
      {
        mode: "native",
        startupMode: "lazy",
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
    );
    handles.push(stack);

    expect(stack.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(stack.dbUrl).toMatch(/127\.0\.0\.1:\d+/);
  });
});
