import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { formatCnameCause, parseFirstCname } from "./domains.cname.ts";

describe("parseFirstCname", () => {
  it("returns the data of the first CNAME answer", () => {
    const result = Effect.runSync(
      parseFirstCname({ Answer: [{ type: 5, data: "foo.supabase.co." }] }, "foo.example.com"),
    );
    expect(result).toBe("foo.supabase.co.");
  });

  it("skips non-CNAME answers and returns the first CNAME", () => {
    const result = Effect.runSync(
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
    const exit = Effect.runSyncExit(
      parseFirstCname({ Answer: [{ type: 5, data: 123 }] }, "foo.example.com"),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("fails with a locate error when no CNAME answer is present", () => {
    const error = Effect.runSync(
      Effect.flip(parseFirstCname({ Answer: [{ type: 1, data: "1.2.3.4" }] }, "host.example.com")),
    );
    expect(error.message).toContain(
      "failed to locate appropriate CNAME record for host.example.com",
    );
  });

  it("treats a payload without an Answer array as no records", () => {
    const exit = Effect.runSyncExit(parseFirstCname({}, "host.example.com"));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("treats a non-object payload as no records", () => {
    const exit = Effect.runSyncExit(parseFirstCname("not-json", "host.example.com"));
    expect(Exit.isFailure(exit)).toBe(true);
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
