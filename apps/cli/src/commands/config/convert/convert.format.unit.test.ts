import { CliConfigConvertError } from "@supabase/config/internal";
import { describe, expect, it } from "vitest";

import { refusalMessage } from "./convert.format.ts";

describe("convert format", () => {
  it("includes the line in refusals only when known", () => {
    const base = { reason: "parse_error", detail: "bad" } as const;
    expect(refusalMessage(new CliConfigConvertError({ ...base, sourceLine: 3 }))).toBe(
      "cannot convert supabase/config.toml at line 3: bad. supabase/config.toml was not changed.",
    );
    expect(refusalMessage(new CliConfigConvertError(base))).toBe(
      "cannot convert supabase/config.toml: bad. supabase/config.toml was not changed.",
    );
  });
});
