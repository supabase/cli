import { describe, expect, it } from "vitest";

import { encodeBannedIpsToml } from "./network-bans.encoders.ts";

describe("encodeBannedIpsToml", () => {
  it("emits a single TOML key with a JSON-escaped string array", () => {
    expect(encodeBannedIpsToml(["1.2.3.4", "5.6.7.8"])).toBe(
      'banned_ips = ["1.2.3.4", "5.6.7.8"]\n',
    );
  });

  it("emits an empty array for an empty input", () => {
    expect(encodeBannedIpsToml([])).toBe("banned_ips = []\n");
  });

  it("JSON-escapes characters that would otherwise break the array literal", () => {
    expect(encodeBannedIpsToml(['1.2.3.4"; evil'])).toBe('banned_ips = ["1.2.3.4\\"; evil"]\n');
  });
});
