import { Flag } from "effect/unstable/cli";
import { describe, expect, it } from "vitest";

import { legacyUnwrapParam, legacyUnwrapToSingleParam } from "./legacy-param-introspection.ts";

describe("legacyUnwrapParam", () => {
  it("unwraps a plain, required flag with isOptional/isVariadic both false and variadicMin 0", () => {
    const result = legacyUnwrapParam(Flag.string("custom-hostname"));
    expect(result?.single.name).toBe("custom-hostname");
    expect(result?.isOptional).toBe(false);
    expect(result?.isVariadic).toBe(false);
    expect(result?.variadicMin).toBe(0);
  });

  it("marks a Flag.optional-wrapped flag as isOptional", () => {
    const result = legacyUnwrapParam(Flag.string("desired-subdomain").pipe(Flag.optional));
    expect(result?.single.name).toBe("desired-subdomain");
    expect(result?.isOptional).toBe(true);
  });

  it("marks a Flag.withDefault-wrapped flag as isOptional (composes as Map(Optional(Single)))", () => {
    const result = legacyUnwrapParam(Flag.string("profile").pipe(Flag.withDefault("supabase")));
    expect(result?.single.name).toBe("profile");
    expect(result?.isOptional).toBe(true);
  });

  it("does not mark a plain boolean flag as isOptional (booleans default to false unwrapped)", () => {
    const result = legacyUnwrapParam(Flag.boolean("debug"));
    expect(result?.single.name).toBe("debug");
    expect(result?.isOptional).toBe(false);
    expect(result?.single.primitiveType._tag).toBe("Boolean");
  });

  it("marks a zero-minimum variadic flag (Flag.atLeast(0)) as variadic but NOT optional, with variadicMin 0", () => {
    // This is the exact shape `legacyStringSliceFlag` builds on
    // (`legacy-string-slice-flag.ts`) — a real bug (CLI-1965 review) treated
    // this as "required" for shell-completion purposes because it isn't
    // `Optional`-wrapped, even though `Param.ts`'s `parseOptionVariadic` only
    // fails with `MissingOption` when `count < min` and `min > 0`, so a
    // zero-minimum variadic flag can legitimately be omitted entirely.
    const result = legacyUnwrapParam(Flag.string("domains").pipe(Flag.atLeast(0)));
    expect(result?.single.name).toBe("domains");
    expect(result?.isOptional).toBe(false);
    expect(result?.isVariadic).toBe(true);
    expect(result?.variadicMin).toBe(0);
  });

  it("captures a positive variadic minimum (Flag.atLeast(2))", () => {
    const result = legacyUnwrapParam(Flag.string("source").pipe(Flag.atLeast(2)));
    expect(result?.isVariadic).toBe(true);
    expect(result?.variadicMin).toBe(2);
  });

  it("captures the minimum from Flag.between", () => {
    const result = legacyUnwrapParam(Flag.string("host").pipe(Flag.between(1, 3)));
    expect(result?.isVariadic).toBe(true);
    expect(result?.variadicMin).toBe(1);
  });

  it("reports variadicMin 0 for an unbounded Flag.atMost (no minimum set)", () => {
    const result = legacyUnwrapParam(Flag.string("warning").pipe(Flag.atMost(3)));
    expect(result?.isVariadic).toBe(true);
    expect(result?.variadicMin).toBe(0);
  });

  it("walks through a chained Map after Optional (Flag.withDefault on a choice flag)", () => {
    const result = legacyUnwrapParam(
      Flag.choice("dns-resolver", ["native", "https"] as const).pipe(Flag.withDefault("native")),
    );
    expect(result?.single.name).toBe("dns-resolver");
    expect(result?.isOptional).toBe(true);
    expect(result?.single.primitiveType._tag).toBe("Choice");
  });

  it("preserves aliases and hidden metadata on the underlying Single", () => {
    const result = legacyUnwrapParam(
      Flag.string("type").pipe(Flag.withAlias("t"), Flag.withHidden),
    );
    expect(result?.single.aliases).toEqual(["t"]);
    expect(result?.single.hidden).toBe(true);
  });
});

describe("legacyUnwrapToSingleParam", () => {
  it("returns just the underlying Single, discarding optional/variadic metadata", () => {
    const single = legacyUnwrapToSingleParam(Flag.string("role").pipe(Flag.optional));
    expect(single?.name).toBe("role");
  });

  it("agrees with legacyUnwrapParam's own .single for the same input", () => {
    const param = Flag.string("status").pipe(Flag.atLeast(0));
    expect(legacyUnwrapToSingleParam(param)).toBe(legacyUnwrapParam(param)?.single);
  });
});
