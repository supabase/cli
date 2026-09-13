import { describe, expect, it } from "vitest";

import { PG_DELTA_CA_BUNDLE } from "./pgdelta-ssl.ts";

describe("PG_DELTA_CA_BUNDLE", () => {
  it("concatenates the three Supabase CA certificates", () => {
    expect(PG_DELTA_CA_BUNDLE.match(/BEGIN CERTIFICATE/g)).toHaveLength(3);
  });
});
