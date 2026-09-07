import { describe, expect, it } from "vitest";
import { Option } from "effect";

import { legacyRemoteCommitToPullFlags } from "./commit.handler.ts";
import type { LegacyDbRemoteCommitFlags } from "./commit.command.ts";

const flags = (over: Partial<LegacyDbRemoteCommitFlags> = {}): LegacyDbRemoteCommitFlags => ({
  schema: over.schema ?? [],
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? false,
  password: over.password ?? Option.none(),
});

describe("legacyRemoteCommitToPullFlags", () => {
  it("leaves --linked unset so pull still targets the linked project by default", () => {
    expect(legacyRemoteCommitToPullFlags(flags()).linked).toEqual(Option.none());
  });

  it("passes --linked only when the flag is set", () => {
    expect(legacyRemoteCommitToPullFlags(flags({ linked: true })).linked).toEqual(
      Option.some(true),
    );
  });
});
