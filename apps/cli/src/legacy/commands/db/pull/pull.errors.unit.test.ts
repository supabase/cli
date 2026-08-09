import { describe, expect, it } from "vitest";
import { classifyCliErrorActionability } from "../../../../shared/telemetry/error-actionability.ts";
import { LegacyDbPullDumpError } from "./pull.errors.ts";

describe("LegacyDbPullDumpError actionability", () => {
  it("classifies a local migration-file open failure as a permission problem", () => {
    const result = classifyCliErrorActionability(
      new LegacyDbPullDumpError({
        message: "failed to open dump file: permission denied",
        fileOpen: true,
      }),
    );
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("permission");
    expect(result.error_fingerprint).toBe("tag:LegacyDbPullDumpError:filesystem");
  });

  it("classifies a pg_dump-run failure as a db-connection problem", () => {
    const result = classifyCliErrorActionability(
      new LegacyDbPullDumpError({ message: "error running container: exit 1" }),
    );
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("db_connection");
    expect(result.error_fingerprint).toBe("tag:LegacyDbPullDumpError:connect");
  });
});
