import { describe, expect, it } from "vitest";

import { legacyClassifyExplicitRef, legacyUnknownTargetMessage } from "./diff.explicit.ts";

describe("legacyClassifyExplicitRef", () => {
  it("recognises the named targets", () => {
    expect(legacyClassifyExplicitRef("local")).toBe("local");
    expect(legacyClassifyExplicitRef("linked")).toBe("linked");
    expect(legacyClassifyExplicitRef("migrations")).toBe("migrations");
  });

  it("recognises postgres URLs", () => {
    expect(legacyClassifyExplicitRef("postgres://u:p@h:5432/db")).toBe("url");
    expect(legacyClassifyExplicitRef("postgresql://u@h/db")).toBe("url");
  });

  it("rejects anything else as unknown", () => {
    expect(legacyClassifyExplicitRef("remote")).toBe("unknown");
    expect(legacyClassifyExplicitRef("https://h/db")).toBe("unknown");
    expect(legacyClassifyExplicitRef("")).toBe("unknown");
  });
});

describe("legacyUnknownTargetMessage", () => {
  it("byte-matches Go's quoted error", () => {
    expect(legacyUnknownTargetMessage("remote")).toBe(
      "unknown target \"remote\": must be one of 'local', 'linked', 'migrations', or a postgres:// URL",
    );
  });
});
