import { describe, expect, it } from "vitest";

import { legacyReadVaultDocument, legacySyncableVaultSecrets } from "./legacy-vault.ts";

describe("legacyReadVaultDocument", () => {
  it("returns undefined when the document or db.vault is absent", () => {
    expect(legacyReadVaultDocument(undefined)).toBeUndefined();
    expect(legacyReadVaultDocument({})).toBeUndefined();
    expect(legacyReadVaultDocument({ db: 5 })).toBeUndefined();
    expect(legacyReadVaultDocument({ db: { vault: "nope" } })).toBeUndefined();
  });

  it("keeps only string-valued entries", () => {
    expect(legacyReadVaultDocument({ db: { vault: { a: "x", b: 1, c: "y" } } })).toEqual({
      a: "x",
      c: "y",
    });
  });
});

describe("legacySyncableVaultSecrets", () => {
  it("returns nothing for an absent table", () => {
    expect(legacySyncableVaultSecrets(undefined)).toEqual([]);
  });

  it("skips empty, env-reference, and encrypted values", () => {
    const result = legacySyncableVaultSecrets({
      empty: "",
      fromEnv: "env(MY_SECRET)",
      encrypted: "encrypted:abc",
      literal: "plain-value",
    });
    expect(result).toEqual([{ key: "literal", value: "plain-value" }]);
  });
});
