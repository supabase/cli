import { Result } from "effect";
import { describe, expect, it } from "vitest";

import { formatCnameCause, parseFirstCname } from "./domains.cname.ts";

describe("parseFirstCname", () => {
  it("returns the data of the first CNAME answer", () => {
    const result = Result.getOrThrow(
      parseFirstCname({ Answer: [{ type: 5, data: "foo.supabase.co." }] }, "foo.example.com"),
    );
    expect(result).toBe("foo.supabase.co.");
  });

  it("skips non-CNAME answers and returns the first CNAME", () => {
    const result = Result.getOrThrow(
      parseFirstCname(
        {
          Answer: [
            { type: 1, data: "1.2.3.4" },
            { type: 5, data: "cname.target." },
          ],
        },
        "foo.example.com",
      ),
    );
    expect(result).toBe("cname.target.");
  });

  it("ignores a CNAME answer whose data is not a string", () => {
    const result = parseFirstCname({ Answer: [{ type: 5, data: 123 }] }, "foo.example.com");
    expect(Result.isFailure(result)).toBe(true);
  });

  it("fails with a non-transport locate failure when no CNAME answer is present", () => {
    const failure = Result.getOrThrow(
      Result.flip(parseFirstCname({ Answer: [{ type: 1, data: "1.2.3.4" }] }, "host.example.com")),
    );
    expect(failure.transport).toBe(false);
    expect(failure.detail).toContain(
      "failed to locate appropriate CNAME record for host.example.com",
    );
  });

  it("treats a payload without an Answer array as no records", () => {
    expect(Result.isFailure(parseFirstCname({}, "host.example.com"))).toBe(true);
  });

  it("treats a non-object payload as no records", () => {
    expect(Result.isFailure(parseFirstCname("not-json", "host.example.com"))).toBe(true);
  });
});

describe("formatCnameCause", () => {
  it("uses the message of an Error", () => {
    expect(formatCnameCause(new Error("boom"))).toBe("boom");
  });

  it("uses a string message field on a plain object", () => {
    expect(formatCnameCause({ message: "obj-msg" })).toBe("obj-msg");
  });

  it("stringifies an object whose message is not a string", () => {
    expect(formatCnameCause({ message: 42 })).toBe("[object Object]");
  });

  it("stringifies a primitive cause", () => {
    expect(formatCnameCause(42)).toBe("42");
  });
});
