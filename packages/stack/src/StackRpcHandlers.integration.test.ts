import { describe, expect, it } from "vitest";
import { StackRpcHandlers } from "./StackRpcHandlers.ts";

describe("Stack RPC handlers", () => {
  it("exports the runtime handler layer", () => {
    expect(StackRpcHandlers).toBeDefined();
  });
});
