import { describe, expect, it } from "vitest";

import { classifyExplicitRef, unknownTargetMessage } from "./diff.explicit.ts";

describe("classifyExplicitRef", () => {
  it("recognises the named targets", () => {
    expect(classifyExplicitRef("local")).toBe("local");
    expect(classifyExplicitRef("linked")).toBe("linked");
    expect(classifyExplicitRef("migrations")).toBe("migrations");
  });

  it("recognises postgres URLs", () => {
    expect(classifyExplicitRef("postgres://u:p@h:5432/db")).toBe("url");
    expect(classifyExplicitRef("postgresql://u@h/db")).toBe("url");
  });

  it("rejects anything else as unknown", () => {
    expect(classifyExplicitRef("remote")).toBe("unknown");
    expect(classifyExplicitRef("https://h/db")).toBe("unknown");
    expect(classifyExplicitRef("")).toBe("unknown");
  });
});

describe("unknownTargetMessage", () => {
  it("byte-matches Go's quoted error", () => {
    expect(unknownTargetMessage("remote")).toBe(
      "unknown target \"remote\": must be one of 'local', 'linked', 'migrations', or a postgres:// URL",
    );
  });
});
