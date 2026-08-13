import { describe, expect, it } from "vitest";
import { classifyCliErrorActionability } from "../../../../shared/telemetry/error-actionability.ts";
import {
  LegacyDeclarativeEdgeRuntimeError,
  LegacyDeclarativeShadowDbError,
} from "./legacy-pgdelta.errors.ts";

describe("pg-delta error actionability", () => {
  it.each([
    ["daemon", "user_actionable", "docker_not_running", "docker_not_running"],
    ["pull", "external_service", "network", "registry_pull"],
    ["inspect", "user_actionable", "invalid_config", "image_inspect"],
  ] as const)("classifies edge-runtime docker %s failures", (docker, kind, category, suffix) => {
    const result = classifyCliErrorActionability(
      new LegacyDeclarativeEdgeRuntimeError({ message: "redacted", docker }),
    );
    expect(result.error_kind).toBe(kind);
    expect(result.error_category).toBe(category);
    expect(result.error_fingerprint).toBe(`tag:LegacyDeclarativeEdgeRuntimeError:${suffix}`);
  });

  it("keeps non-docker edge-runtime failures in the database family", () => {
    const result = classifyCliErrorActionability(
      new LegacyDeclarativeEdgeRuntimeError({ message: "redacted" }),
    );
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("invalid_config");
    expect(result.error_fingerprint).toBe("tag:LegacyDeclarativeEdgeRuntimeError");
  });

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
