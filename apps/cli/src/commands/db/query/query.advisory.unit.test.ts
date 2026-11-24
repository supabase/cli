import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { buildRlsAdvisory } from "./query.advisory.ts";

describe("buildRlsAdvisory", () => {
  it("returns None when no tables are unprotected", () => {
    expect(Option.isNone(buildRlsAdvisory([]))).toBe(true);
  });

  it("lists the unprotected tables and joins remediation statements", () => {
    const advisory = buildRlsAdvisory(["public.a", "public.b"]);
    expect(Option.isSome(advisory)).toBe(true);
    if (Option.isSome(advisory)) {
      expect(advisory.value.message).toContain("2 table(s)");
      expect(advisory.value.message).toContain("public.a, public.b");
      expect(advisory.value.remediation_sql).toBe(
        "ALTER TABLE public.a ENABLE ROW LEVEL SECURITY;\nALTER TABLE public.b ENABLE ROW LEVEL SECURITY;",
      );
    }
  });
});
