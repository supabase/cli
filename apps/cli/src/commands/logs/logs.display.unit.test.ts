import { wrapTerminalText as wrapLogsText } from "../../shared/output/wrap-terminal-text.ts";
import { describe, expect, it } from "vitest";
import { stringWidth } from "../../command-internal/string-width.ts";
import { renderLogsRows, renderLogsSources } from "./logs.display.ts";

describe("readable logs output", () => {
  for (const width of [80, 120]) {
    it(`preserves long Unicode messages and nested values within ${width} columns`, () => {
      const message = "界🙂e\u0301".repeat(70);
      const nested = { request: { path: "/" + "x".repeat(160), ok: true }, tags: ["auth", "db"] };
      const output = renderLogsRows([{ event_message: message, log_attributes: nested }], width);
      expect(output.split("\n").every((line) => stringWidth(line) <= width)).toBe(true);
      expect(output).toContain("Row 1\nevent_message:\n");
      expect(output.replaceAll("\n", "").replaceAll(" ", "")).toContain(message);
      const attributes = output.split("log_attributes:\n")[1];
      expect(
        JSON.parse(
          attributes
            ?.trimEnd()
            .split("\n")
            .map((line) => line.slice(2))
            .join("") ?? "",
        ),
      ).toEqual(nested);
    });

    it(`wraps full source details and lists capabilities as words at ${width} columns`, () => {
      const sql =
        "logs WHERE log_attributes['subservice'] IN ('worker_guest_logs','worker_ingress_logs','worker_api_logs')";
      const output = renderLogsSources(
        [
          {
            service: "compute",
            sql,
            filters: ["service", "resource", "kind", "level", "search", "since"],
            kinds: ["app", "requests", "builds"],
            severity: "Derived for requests/builds; app severity is unknown.",
          },
        ],
        true,
        width,
      );
      expect(output.split("\n").every((line) => stringWidth(line) <= width)).toBe(true);
      expect(output).toContain("Filters:\n  service, resource, kind, level, search, since");
      expect(output).toContain("Kinds:\n  app, requests, builds");
      const actualSql = output.split("SQL:\n")[1]?.split("\nFilters:")[0];
      expect(
        actualSql
          ?.split("\n")
          .map((line) => line.slice(2))
          .join(""),
      ).toBe(sql);
    });
  }

  it("keeps small scalar results tabular and removes terminal control codes from aliases and values", () => {
    const output = renderLogsRows([{ "\u001b[31mcount\u001b[0m": 3, message: "a\tb" }], 80);
    expect(output).toContain("│ count │ message │");
    expect(output).toContain("│ 3     │ a    b  │");
    expect(output).not.toContain("\u001b");
    const multiline = renderLogsRows([{ "a\nb": 1 }], 80);
    expect(multiline).toBe("Row 1\na\nb:\n  1\n");
  });

  it("uses available width to choose a table or full wrapped scalar record", () => {
    const message = "x".repeat(90);
    const narrow = renderLogsRows([{ message }], 80);
    expect(narrow).toContain("Row 1\nmessage:");
    expect(narrow.split("\n").every((line) => stringWidth(line) <= 80)).toBe(true);
    expect(narrow.replaceAll("\n", "").replaceAll(" ", "")).toContain(message);
    const wide = renderLogsRows([{ message }], 120);
    expect(wide).toContain(`│ ${message} │`);
    expect(wide).not.toContain("Row 1");
  });

  it("shows a compact overview with discoverable service details", () => {
    const output = renderLogsSources(
      [{ service: "postgres", sql: "not in overview", filters: ["service"], kinds: [] }],
      false,
      80,
    );
    expect(output).toContain("postgres");
    expect(output).toContain("Use --service <service>");
    expect(output).not.toContain("not in overview");
    expect(output).not.toContain("│ filters");
  });

  it("wraps human tail lines without losing spaces or multiline content", () => {
    const line = "2026-11-02T12:00:00Z postgres " + "hello world ".repeat(20) + "\nlast line";
    const output = wrapLogsText(line, 80);
    expect(output.split("\n").every((part) => stringWidth(part) <= 80)).toBe(true);
    expect(output.replaceAll("\n", "")).toBe(line.replaceAll("\n", ""));
  });
});
