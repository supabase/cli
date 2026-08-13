import { describe, expect, it } from "vitest";
import { stackIdentity } from "./StackIdentity.ts";

describe("stackIdentity", () => {
  it("keeps explicit identities separate from port-derived names", () => {
    const portIdentity = stackIdentity({ apiPort: 54_321 });
    const explicitIdentity = stackIdentity({ apiPort: 12_345, instanceId: "54321" });

    expect(explicitIdentity).toEqual({ key: "id-54321", stackId: "54321" });
    expect(portIdentity).toEqual({ key: "54321", stackId: undefined });
  });
});
