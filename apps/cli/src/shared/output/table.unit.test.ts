import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { columnWidths, formatTableRow, outputTable } from "./table.ts";

describe("columnWidths", () => {
  it("uses the header width when it is wider than all cells", () => {
    expect(columnWidths(["STATUS"], [["OK"]])).toEqual([6]);
  });

  it("uses the cell width when a cell is wider than the header", () => {
    expect(columnWidths(["ID"], [["abcdefghijklmnopqrst"]])).toEqual([20]);
  });

  it("takes the max across all rows", () => {
    expect(columnWidths(["NAME"], [["alice"], ["bob"], ["charlotte"]])).toEqual([9]);
  });

  it("handles multiple columns independently", () => {
    expect(columnWidths(["A", "LONG_HEADER"], [["abc", "x"]])).toEqual([3, 11]);
  });
});

describe("formatTableRow", () => {
  it("pads cells to their column widths and joins with a 2-space separator", () => {
    expect(formatTableRow(["hi", "there"], [5, 8])).toBe("hi     there   ");
  });

  it("does not pad a cell that exactly fills its column", () => {
    expect(formatTableRow(["abc"], [3])).toBe("abc");
  });
});

describe("outputTable", () => {
  it("emits a header row then one info message per data item", async () => {
    const out = mockOutput();
    await Effect.runPromise(
      outputTable(["ID", "NAME"], [{ id: "1", name: "main" }], (r) => [r.id, r.name]).pipe(
        Effect.provide(out.layer),
      ),
    );
    const infos = out.messages.filter((m) => m.type === "info").map((m) => m.message);
    expect(infos).toEqual(["ID  NAME", "1   main"]);
  });

  it("uses header width when wider than any cell", async () => {
    const out = mockOutput();
    await Effect.runPromise(
      outputTable(["STATUS"], [{ s: "OK" }], (r) => [r.s]).pipe(Effect.provide(out.layer)),
    );
    const infos = out.messages.filter((m) => m.type === "info").map((m) => m.message);
    expect(infos[0]).toBe("STATUS");
    expect(infos[1]).toBe("OK    ");
  });

  it("calls formatRow with cells, widths, and original item to produce row string", async () => {
    const out = mockOutput();
    const captured: Array<{
      cells: ReadonlyArray<string>;
      widths: ReadonlyArray<number>;
      item: { name: string };
    }> = [];
    await Effect.runPromise(
      outputTable(
        ["NAME"],
        [{ name: "alice" }],
        (r) => [r.name],
        (cells, widths, item) => {
          captured.push({ cells, widths, item });
          return formatTableRow(cells, widths) + " [custom]";
        },
      ).pipe(Effect.provide(out.layer)),
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]!.cells).toEqual(["alice"]);
    expect(captured[0]!.widths).toEqual([5]);
    expect(captured[0]!.item).toEqual({ name: "alice" });
    const infos = out.messages.filter((m) => m.type === "info").map((m) => m.message);
    expect(infos[1]).toBe("alice [custom]");
  });
});
