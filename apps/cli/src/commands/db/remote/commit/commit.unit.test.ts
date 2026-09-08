import { describe, expect, it } from "vitest";
import { Option } from "effect";

import { remoteCommitToPullFlags } from "./commit.handler.ts";
import type { DbRemoteCommitFlags } from "./commit.command.ts";

const flags = (over: Partial<DbRemoteCommitFlags> = {}): DbRemoteCommitFlags => ({
  schema: over.schema ?? [],
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? false,
  password: over.password ?? Option.none(),
});

describe("remoteCommitToPullFlags", () => {
  it("leaves --linked unset so pull still targets the linked project by default", () => {
    expect(remoteCommitToPullFlags(flags()).linked).toEqual(Option.none());
  });

  it("passes --linked only when the flag is set", () => {
    expect(remoteCommitToPullFlags(flags({ linked: true })).linked).toEqual(Option.some(true));
  });
});
