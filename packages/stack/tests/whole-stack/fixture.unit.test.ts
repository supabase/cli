import { expect, it } from "@effect/vitest";
import { tailLines } from "./fixture.ts";

it("keeps only the last lines of a bounded owner log tail", () => {
  const content = Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n");
  const tail = tailLines(content, 40);
  expect(tail.split("\n")).toHaveLength(40);
  expect(tail.split("\n")[0]).toBe("line 10");
  expect(tail.split("\n").at(-1)).toBe("line 49");
});

it("trims trailing blank lines before bounding", () => {
  expect(tailLines("first\nsecond\n\n", 40)).toBe("first\nsecond");
});
