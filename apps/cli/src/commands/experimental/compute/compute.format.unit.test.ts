import { describe, expect, it } from "vitest";
import { formatWaited, renderComputeDetails } from "./compute.format.ts";

describe("renderComputeDetails", () => {
  it("pads every label to the widest one", () => {
    expect(
      renderComputeDetails([
        ["State", "active"],
        ["Runtime", "node"],
      ]),
    ).toBe("  State    active\n  Runtime  node\n");
  });

  it("drops rows whose value is empty", () => {
    expect(
      renderComputeDetails([
        ["State", "active"],
        ["Image", ""],
      ]),
    ).toBe("  State  active\n");
  });

  // Several reported fields are optional in the API contract, so a compute can
  // answer with nothing worth rendering. Returning "" rather than a bare newline
  // keeps the caller from printing an empty block under its headline.
  it("renders nothing at all when every value is empty", () => {
    expect(
      renderComputeDetails([
        ["Image", ""],
        ["URL", ""],
      ]),
    ).toBe("");
  });
});

describe("formatWaited", () => {
  it("reports a sub-minute wait in seconds", () => {
    expect(formatWaited(48_000)).toBe("48s");
  });

  it("pads the seconds so minute-scale waits align in a column", () => {
    expect(formatWaited(201_000)).toBe("3m21s");
    expect(formatWaited(184_000)).toBe("3m04s");
  });

  it("drops to minutes past an hour, where the seconds are noise", () => {
    expect(formatWaited(3_840_000)).toBe("1h04m");
  });

  // Rounds rather than truncates, so a poll that lands at 1999ms is not reported as one second.
  it("rounds to whole seconds", () => {
    expect(formatWaited(1_600)).toBe("2s");
    expect(formatWaited(0)).toBe("0s");
  });
});
