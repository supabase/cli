import { describe, expect, it } from "vitest";

import { LEGACY_PG_DELTA_CA_BUNDLE } from "./legacy-pgdelta-ssl.ts";

describe("LEGACY_PG_DELTA_CA_BUNDLE", () => {
  it("concatenates the three Supabase CA certificates", () => {
    expect(LEGACY_PG_DELTA_CA_BUNDLE.match(/BEGIN CERTIFICATE/g)).toHaveLength(3);
  });
});
