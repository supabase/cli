import { describe, expect, it } from "vitest";
import { normalize } from "./normalize.ts";

describe("normalize", () => {
  it("strips ANSI escape codes", () => {
    expect(normalize("\x1b[32mGreen text\x1b[0m")).toBe("Green text");
    expect(normalize("\x1b[1;31mBold red\x1b[0m normal")).toBe("Bold red normal");
    expect(normalize("no codes")).toBe("no codes");
  });

  it("normalizes semantic version strings", () => {
    expect(normalize("supabase 1.187.0")).toBe("supabase <VERSION>");
    expect(normalize("v2.0.0")).toBe("<VERSION>");
    expect(normalize("Version: 0.1.0-rc.1")).toBe("Version: <VERSION>");
  });

  it("does not normalize IP addresses as version strings", () => {
    expect(normalize("host 127.0.0.1")).toBe("host 127.0.0.1");
    expect(normalize("192.168.1.1")).toBe("192.168.1.1");
  });

  it("normalizes ISO-8601 timestamps", () => {
    expect(normalize("2026-04-15T10:46:15Z")).toBe("<TIMESTAMP>");
    expect(normalize("2026-04-15T10:46:15.123Z")).toBe("<TIMESTAMP>");
    expect(normalize("created at 2026-04-15T10:46:15Z done")).toBe("created at <TIMESTAMP> done");
  });

  it("normalizes display timestamps (space-separated)", () => {
    expect(normalize("2026-04-15 10:46:15")).toBe("<TIMESTAMP>");
    expect(normalize("Created: 2026-03-24 14:04:29")).toBe("Created: <TIMESTAMP>");
  });

  it("normalizes UUIDs", () => {
    expect(normalize("id: 123e4567-e89b-12d3-a456-426614174000")).toBe("id: <UUID>");
    expect(normalize("ID: 123E4567-E89B-12D3-A456-426614174000")).toBe("ID: <UUID>");
  });

  it("normalizes durations", () => {
    expect(normalize("took 1.23s")).toBe("took <DURATION>");
    expect(normalize("completed in 42ms")).toBe("completed in <DURATION>");
    expect(normalize("elapsed 100s")).toBe("elapsed <DURATION>");
  });

  it("does not normalize partial duration-like strings", () => {
    // "ms" or "s" must be standalone (word boundary)
    expect(normalize("https://example.com")).toBe("https://example.com");
  });

  it("normalizes Unix absolute paths", () => {
    expect(normalize("/Users/colum/supabase/cli/config.toml")).toBe("<PATH>");
    expect(normalize("/home/runner/work/config")).toBe("<PATH>");
    expect(normalize("/tmp/cli-e2e-profile-abc.yaml")).toBe("<PATH>");
    expect(normalize("/var/log/app.log")).toBe("<PATH>");
  });

  it("normalizes Windows absolute paths", () => {
    expect(normalize("C:\\Users\\colum\\config.toml")).toBe("<PATH>");
    expect(normalize("D:\\work\\project\\file.ts")).toBe("<PATH>");
  });

  it("normalizes Go goroutine stack trace blocks", () => {
    const trace = [
      "goroutine 1 [running]:",
      "main.main()",
      "\t/Users/colum/go/src/main.go:10",
    ].join("\n");
    expect(normalize(trace)).toBe("<STACK_TRACE>");
  });

  it("normalizes Node/Bun stack trace lines", () => {
    const trace = [
      "Error: something failed",
      "    at functionName (file.ts:123:45)",
      "    at anotherFn (other.ts:456:78)",
    ].join("\n");
    // Replacement appends a newline to preserve line structure when more content follows.
    expect(normalize(trace)).toBe("Error: something failed\n<STACK_TRACE>\n");
  });

  it("normalizes file reference line numbers", () => {
    expect(normalize("error at profile.go:108")).toBe("error at profile.go:<LINE>");
    expect(normalize("in file.ts:123:45")).toBe("in file.ts:<LINE>");
    expect(normalize("src/index.ts:10 failed")).toBe("src/index.ts:<LINE> failed");
  });

  it("strips trailing whitespace from each line", () => {
    expect(normalize("line one   \nline two  ")).toBe("line one\nline two");
    expect(normalize("  no trailing  \n  spaces  \n")).toBe("  no trailing\n  spaces\n");
  });

  it("collapses three or more consecutive blank lines to two newlines", () => {
    expect(normalize("a\n\n\n\nb")).toBe("a\n\nb");
    expect(normalize("a\n\n\n\n\nb")).toBe("a\n\nb");
    // Two blank lines unchanged
    expect(normalize("a\n\n\nb")).toBe("a\n\nb");
  });

  it("is a no-op on clean CLI table output", () => {
    const table =
      "\n  \n   ID                   | NAME\n  ----------------------|----------\n   <PROJECT_REF_1>      | My Org\n\n";
    expect(normalize(table)).toBe(table.replace(/[ \t]+$/gm, ""));
  });
});
