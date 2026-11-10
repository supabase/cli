import { describe, expect, it } from "vitest";

import { reportableUnknownCliConfigKeys, suggestCliConfigKey } from "./cli-config-unknown-keys.ts";

describe("reportableUnknownCliConfigKeys", () => {
  it("reports an unknown key with the keys its table accepts", () => {
    const [found] = reportableUnknownCliConfigKeys({ api: { prot: 1 } });

    expect(found?.path).toEqual(["api", "prot"]);
    expect(found?.knownKeys).toContain("port");
  });

  it("ignores document-only keys at the root and in a remote", () => {
    expect(
      reportableUnknownCliConfigKeys({
        db: { password: "pw", root_key: "rk" },
        remotes: { staging: { db: { password: "pw" } } },
      }),
    ).toEqual([]);
  });

  it("ignores custom auth providers", () => {
    expect(
      reportableUnknownCliConfigKeys({ auth: { external: { my_oidc: { enabled: true } } } }),
    ).toEqual([]);
  });

  it("offers document-only tables as siblings of an unknown auth key", () => {
    const [found] = reportableUnknownCliConfigKeys({ auth: { passkeys: { enabled: true } } });

    expect(found?.path).toEqual(["auth", "passkeys"]);
    expect(found?.knownKeys).toContain("passkey");
  });
});

describe("suggestCliConfigKey", () => {
  it("suggests the closest accepted key", () => {
    expect(suggestCliConfigKey("prot", ["port", "enabled", "schemas"])).toBe("port");
  });

  it("suggests nothing beyond two edits", () => {
    expect(suggestCliConfigKey("completely_different", ["port", "enabled"])).toBeUndefined();
  });

  it("suggests nothing when two keys tie for closest", () => {
    expect(suggestCliConfigKey("pot", ["port", "post"])).toBeUndefined();
  });

  it("suggests nothing when there are no candidates", () => {
    expect(suggestCliConfigKey("prot", [])).toBeUndefined();
  });
});
