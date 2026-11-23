import { describe, expect, it } from "vitest";

import { cliConfigDocumentOnlyPaths } from "./cli-config-keys.ts";
import { setDocumentValue } from "./cli-config-document.ts";
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

  it("flags an unknown child of a document-only table", () => {
    expect(
      reportableUnknownCliConfigKeys({
        auth: { passkey: { enabld: true }, webauthn: { rp_id: "x", rp_idd: "y" } },
      }).map(({ path }) => path.join(".")),
    ).toEqual(["auth.passkey.enabld", "auth.webauthn.rp_idd"]);
  });

  it("accepts every registered child of a document-only table", () => {
    expect(
      reportableUnknownCliConfigKeys({
        db: { password: "x" },
        auth: { passkey: { enabled: true }, webauthn: { rp_id: "x", rp_origins: [] } },
      }),
    ).toEqual([]);
  });

  it("never warns about a registered document-only key, at the root or in a remote", () => {
    const base: Record<string, unknown> = {};
    for (const path of cliConfigDocumentOnlyPaths) setDocumentValue(base, path.split("."), "x");
    const remote = structuredClone(base);

    expect(reportableUnknownCliConfigKeys({ ...base, remotes: { staging: remote } })).toEqual([]);
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
