import { describe, expect, it } from "vitest";
import { flattenLocalStackConfigParity } from "./local-stack-config-parity.ts";

describe("localStackConfigParity", () => {
  const entries = flattenLocalStackConfigParity();

  it("classifies every fixed project-config leaf exactly once", () => {
    const paths = entries.map(({ path }) => path);

    expect(paths).toHaveLength(361);
    expect(new Set(paths).size).toBe(paths.length);
    expect(
      Object.fromEntries(
        ["mapped", "not-applicable", "unsupported-blocking", "unsupported-warning"].map((tag) => [
          tag,
          entries.filter(({ decision }) => decision._tag === tag).length,
        ]),
      ),
    ).toEqual({
      mapped: 12,
      "not-applicable": 9,
      "unsupported-blocking": 334,
      "unsupported-warning": 6,
    });
  });

  it("claims only behavior implemented by a current next local-runtime flow as mapped", () => {
    expect(
      entries
        .filter(({ decision }) => decision._tag === "mapped")
        .map(({ path }) => path)
        .sort(),
    ).toEqual([
      "api.auto_expose_new_tables",
      "db.health_timeout",
      "edge_runtime.enabled",
      "edge_runtime.inspector_port",
      "edge_runtime.policy",
      "edge_runtime.secrets",
      "functions.*.enabled",
      "functions.*.entrypoint",
      "functions.*.env",
      "functions.*.import_map",
      "functions.*.static_files",
      "functions.*.verify_jwt",
    ]);
  });

  it("preserves raw-document requirements for presence-sensitive sections", () => {
    const byPath = new Map(entries.map(({ path, decision }) => [path, decision]));

    expect(byPath.get("api.auto_expose_new_tables")?.presence).toBe("raw-document");
    expect(byPath.get("auth.external.github.enabled")?.presence).toBe("raw-document");
    expect(byPath.get("auth.hook.send_email.enabled")?.presence).toBe("raw-document");
    expect(byPath.get("auth.sms.twilio.enabled")?.presence).toBe("raw-document");
    expect(byPath.get("storage.image_transformation.enabled")?.presence).toBe("raw-document");
    expect(byPath.get("experimental.webhooks.enabled")?.presence).toBe("raw-document");
  });

  it("keeps non-runtime project configuration out of StackConfig", () => {
    expect(
      entries
        .filter(({ decision }) => decision._tag === "not-applicable")
        .map(({ path }) => path)
        .sort(),
    ).toEqual([
      "db.network_restrictions.allowed_cidrs",
      "db.network_restrictions.allowed_cidrs_v6",
      "db.network_restrictions.enabled",
      "db.shadow_port",
      "experimental.inspect.rules",
      "experimental.pgdelta.declarative_schema_path",
      "experimental.pgdelta.enabled",
      "experimental.pgdelta.format_options",
      "remotes",
    ]);
  });
});
