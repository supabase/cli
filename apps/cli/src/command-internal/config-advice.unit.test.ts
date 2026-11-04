import { Path } from "effect";
import { BunPath } from "@effect/platform-bun";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  configFileName,
  configFileRefFromPath,
  configKey,
  configSetting,
  DEFAULT_CONFIG_FILE,
} from "./config-advice.ts";
import { schemaPathsTransitionWarning } from "./diff-engine.ts";
import { enableLocalWebhooksSuggestion } from "./pg-net-guidance.ts";

const json = { format: "json", path: "supabase/config.json" } as const;

describe("config advice", () => {
  it("renders a setting as TOML section syntax or a JSON dotted key", () => {
    expect(configSetting("toml", "storage", "enabled", "true")).toBe("[storage] enabled = true");
    expect(configSetting("json", "storage", "enabled", "true")).toBe("`storage.enabled` to `true`");
    expect(configKey("toml", "db", "password")).toBe("[db].password");
    expect(configKey("json", "db", "password")).toBe("db.password");
  });

  it("maps a config path to its format and workdir-relative display path", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(configFileRefFromPath(path, "/work", "/work/supabase/config.jsonc")).toEqual({
        format: "json",
        path: "supabase/config.jsonc",
      });
      expect(configFileRefFromPath(path, "/work", undefined)).toEqual(DEFAULT_CONFIG_FILE);
      expect(configFileName("supabase/config.json")).toBe("config.json");
    }).pipe(Effect.provide(BunPath.layer), Effect.runSync));

  it("keeps TOML guidance text and gives JSON projects a JSON snippet", () => {
    expect(enableLocalWebhooksSuggestion()).toBe(
      "Add the following to supabase/config.toml and retry:\n\n[experimental.webhooks]\nenabled = true",
    );
    expect(enableLocalWebhooksSuggestion(json)).toContain(
      '{\n  "experimental": {\n    "webhooks": {\n      "enabled": true',
    );
    expect(schemaPathsTransitionWarning()).toContain("[db.migrations].schema_paths");
    expect(schemaPathsTransitionWarning(json)).toContain(
      "`experimental.pgdelta.enabled` to `false`",
    );
  });
});
