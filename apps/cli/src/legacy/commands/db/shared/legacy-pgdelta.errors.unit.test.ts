import { describe, expect, it } from "vitest";
import { classifyCliErrorActionability } from "../../../../shared/telemetry/error-actionability.ts";
import { LegacyDeclarativeShadowDbError } from "./legacy-pgdelta.errors.ts";

describe("pg-delta error actionability", () => {
  it("distinguishes an unreachable Docker daemon from a missing shadow stack", () => {
    const daemon = classifyCliErrorActionability(
      new LegacyDeclarativeShadowDbError({ message: "redacted", docker: "daemon" }),
    );
    expect(daemon.error_category).toBe("docker_not_running");
    expect(daemon.error_fingerprint).toBe("tag:LegacyDeclarativeShadowDbError:docker_not_running");

    const missingStack = classifyCliErrorActionability(
      new LegacyDeclarativeShadowDbError({ message: "redacted" }),
    );
    expect(missingStack.error_category).toBe("invalid_config");
    expect(missingStack.suggested_command).toBe("supabase start");
    expect(missingStack.error_fingerprint).toBe("tag:LegacyDeclarativeShadowDbError");
  });
});
