import { describe, expect, it } from "vitest";

import {
  actionability,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";
import { StackCommandStartError } from "./start.errors.ts";

describe("StackCommandStartError actionability", () => {
  it("classifies a seed failure as recoverable with supabase seed buckets", () => {
    const error = new StackCommandStartError({ reason: "seed", message: "x" });

    expect(error[ErrorActionabilityId]).toEqual(actionability.seedBuckets);
  });
});
