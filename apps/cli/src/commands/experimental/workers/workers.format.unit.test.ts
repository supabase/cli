import { describe, expect, it } from "vitest";
import { renderWorkerDetails } from "./workers.format.ts";

describe("renderWorkerDetails", () => {
  it("pads every label to the widest one", () => {
    expect(
      renderWorkerDetails([
        ["State", "active"],
        ["Runtime", "node"],
      ]),
    ).toBe("  State    active\n  Runtime  node\n");
  });

  it("drops rows whose value is empty", () => {
    expect(
      renderWorkerDetails([
        ["State", "active"],
        ["Image", ""],
      ]),
    ).toBe("  State  active\n");
  });

  // Several reported fields are optional in the API contract, so a worker can
  // answer with nothing worth rendering. Returning "" rather than a bare newline
  // keeps the caller from printing an empty block under its headline.
  it("renders nothing at all when every value is empty", () => {
    expect(
      renderWorkerDetails([
        ["Image", ""],
        ["URL", ""],
      ]),
    ).toBe("");
  });
});
