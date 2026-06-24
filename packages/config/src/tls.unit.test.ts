import { describe, expect, it } from "vitest";

import { KONG_LOCAL_CA_CERT } from "./tls.ts";

describe("KONG_LOCAL_CA_CERT", () => {
  it("is a non-empty PEM certificate", () => {
    expect(KONG_LOCAL_CA_CERT).toContain("BEGIN CERTIFICATE");
    expect(KONG_LOCAL_CA_CERT).toContain("END CERTIFICATE");
    expect(KONG_LOCAL_CA_CERT.length).toBeGreaterThan(0);
  });
});
