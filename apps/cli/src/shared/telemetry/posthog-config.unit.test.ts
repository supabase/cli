import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { processEnvLayer } from "../../../tests/helpers/mocks.ts";
import { resolvePosthogConfig } from "./posthog-config.ts";

describe("resolvePosthogConfig", () => {
  it.live("uses no key when nothing is injected or overridden", () =>
    Effect.sync(() => {
      const config = resolvePosthogConfig({});

      expect(config.host).toBe("https://eu.i.posthog.com");
      expect(Option.isNone(config.key)).toBe(true);
    }).pipe(Effect.provide(processEnvLayer())),
  );

  it.live("uses the build-injected key and host by default", () =>
    Effect.sync(() => {
      const config = resolvePosthogConfig({});

      expect(config.host).toBe("https://build-posthog.example");
      expect(config.key).toEqual(Option.some("phc_build_key"));
    }).pipe(
      Effect.provide(
        processEnvLayer({
          SUPABASE_CLI_POSTHOG_HOST: "https://build-posthog.example",
          SUPABASE_CLI_POSTHOG_KEY: "phc_build_key",
        }),
      ),
    ),
  );

  it.live("prefers runtime overrides over build-injected values", () =>
    Effect.sync(() => {
      const config = resolvePosthogConfig({
        SUPABASE_TELEMETRY_POSTHOG_HOST: "https://runtime-posthog.example",
        SUPABASE_TELEMETRY_POSTHOG_KEY: "phc_runtime_key",
      });

      expect(config.host).toBe("https://runtime-posthog.example");
      expect(config.key).toEqual(Option.some("phc_runtime_key"));
    }).pipe(
      Effect.provide(
        processEnvLayer({
          SUPABASE_CLI_POSTHOG_HOST: "https://build-posthog.example",
          SUPABASE_CLI_POSTHOG_KEY: "phc_build_key",
        }),
      ),
    ),
  );
});
