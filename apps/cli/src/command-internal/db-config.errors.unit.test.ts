import { describe, expect, it } from "vitest";

import { classifyCliErrorActionability } from "../shared/telemetry/error-actionability.ts";
import { DbConfigIpv6Error } from "./db-config.errors.ts";

describe("DbConfigIpv6Error", () => {
  it.each([undefined, "link"] as const)(
    "sends a %s remedy to supabase link and stays a connection failure",
    (remedy) => {
      expect(
        classifyCliErrorActionability(new DbConfigIpv6Error({ message: "m", remedy })),
      ).toMatchObject({
        error_kind: "user_actionable",
        error_category: "db_connection",
        has_suggestion: true,
        suggestion_type: "link_project",
        suggested_command: "supabase link",
      });
    },
  );

  it("asks for flags, with no command to run, when the remedy is a pooler URL", () => {
    const classified = classifyCliErrorActionability(
      new DbConfigIpv6Error({ message: "m", remedy: "pooler-url" }),
    );
    expect(classified).toMatchObject({
      error_kind: "user_actionable",
      error_category: "db_connection",
      has_suggestion: true,
      suggestion_type: "provide_flags",
    });
    expect(classified).not.toHaveProperty("suggested_command");
  });
});
