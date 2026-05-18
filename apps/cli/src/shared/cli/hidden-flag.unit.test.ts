import { Context, Option } from "effect";
import { Flag, type HelpDoc } from "effect/unstable/cli";
import { describe, expect, it } from "vitest";
import { stripHiddenFlagsFromHelpDoc, withHidden } from "./hidden-flag.ts";

const flagDoc = (name: string): HelpDoc.FlagDoc => ({
  name,
  aliases: [`--${name}`],
  type: "boolean",
  description: Option.none(),
  required: false,
});

const helpDoc = (overrides: Partial<HelpDoc.HelpDoc>): HelpDoc.HelpDoc => ({
  description: "",
  usage: "",
  flags: [],
  annotations: Context.empty(),
  ...overrides,
});

describe("withHidden", () => {
  it("returns the same flag instance", () => {
    const flag = Flag.boolean("legacy-bundle");
    expect(withHidden(flag)).toBe(flag);
  });

  it("registers the underlying single name even when wrapped with combinators", () => {
    const flag = Flag.string("plan").pipe(Flag.optional);
    withHidden(flag);

    const stripped = stripHiddenFlagsFromHelpDoc(
      helpDoc({ flags: [flagDoc("plan"), flagDoc("visible")] }),
    );
    expect(stripped.flags.map((f) => f.name)).toEqual(["visible"]);
  });

  it("filters hidden flags from globalFlags as well", () => {
    withHidden(Flag.boolean("preview"));

    const stripped = stripHiddenFlagsFromHelpDoc(
      helpDoc({ globalFlags: [flagDoc("preview"), flagDoc("verbose")] }),
    );
    expect(stripped.globalFlags?.map((f) => f.name)).toEqual(["verbose"]);
  });

  it("leaves docs without globalFlags untouched", () => {
    const stripped = stripHiddenFlagsFromHelpDoc(helpDoc({ flags: [flagDoc("foo")] }));
    expect(stripped.globalFlags).toBeUndefined();
    expect(stripped.flags.map((f) => f.name)).toEqual(["foo"]);
  });
});
