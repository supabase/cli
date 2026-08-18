import { describe, expect, it } from "vitest";
import { classifyCliErrorActionability } from "../../../../shared/telemetry/error-actionability.ts";
import { LegacyMigraDiffError } from "./legacy-migra.errors.ts";

describe("LegacyMigraDiffError actionability", () => {
  it("classifies a docker-daemon failure as docker-not-running", () => {
    const result = classifyCliErrorActionability(
      new LegacyMigraDiffError({ message: "error diffing schema: ...", docker: "daemon" }),
    );
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("docker_not_running");
    expect(result.suggestion_type).toBe("start_docker");
    expect(result.error_fingerprint).toBe("tag:LegacyMigraDiffError:docker_not_running");
  });

  it("classifies a registry-pull failure as an external network problem", () => {
    const result = classifyCliErrorActionability(
      new LegacyMigraDiffError({ message: "error diffing schema: ...", docker: "pull" }),
    );
    expect(result.error_kind).toBe("external_service");
    expect(result.error_category).toBe("network");
    expect(result.error_fingerprint).toBe("tag:LegacyMigraDiffError:registry_pull");
  });

  it("classifies a non-docker diff failure as a user db finding", () => {
    const result = classifyCliErrorActionability(
      new LegacyMigraDiffError({ message: "error diffing schema:\n..." }),
    );
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("invalid_config");
    expect(result.has_suggestion).toBe(false);
    expect(result.error_fingerprint).toBe("tag:LegacyMigraDiffError");
  });
});
