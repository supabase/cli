import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";

import {
  VALID_REF,
  mockCommandPlatformApi,
  mockCommandSettings,
} from "../../tests/helpers/command-mocks.ts";
import { mockRuntimeInfo } from "../../tests/helpers/mocks.ts";
import { assertBlockDrift } from "../../tests/helpers/permission-drift.ts";
import { unusedStackServices } from "../../tests/helpers/unused-stack.ts";
import { resolveStorageCredentials, storageCredentials } from "./storage-credentials.ts";

const apiKeys = [
  { name: "anon", api_key: "anon-key", type: "legacy" },
  { name: "service_role", api_key: "service-role-key", type: "legacy" },
];
const config = { api: { enabled: true, port: 54321, tls: { enabled: false } }, auth: {} };

describe("resolveStorageCredentials for a remote project", () => {
  const resolve = (
    api: ReturnType<typeof mockCommandPlatformApi>,
    env: Record<string, string> = {},
  ) =>
    resolveStorageCredentials({ projectRef: VALID_REF, config }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)),
          api.factoryLayer,
          mockCommandSettings({ workdir: "/unused" }),
          mockRuntimeInfo(),
          unusedStackServices,
          NodeServices.layer,
        ),
      ),
    );

  it.live("fetches the service-role key from the project api-keys without an env override", () => {
    const api = mockCommandPlatformApi({ response: { status: 200, body: apiKeys } });
    return Effect.gen(function* () {
      const credentials = yield* resolve(api);

      expect(credentials.apiKey).toBe("service-role-key");
      expect(api.requests.map((request) => request.urlParams)).toEqual(["reveal=true"]);
      assertBlockDrift(storageCredentials, {
        activeFlags: {},
        requests: api.requests,
      });
    });
  });

  it.live("requests no api-keys when SUPABASE_AUTH_SERVICE_ROLE_KEY is set", () => {
    const api = mockCommandPlatformApi({ response: { status: 200, body: apiKeys } });
    return Effect.gen(function* () {
      const credentials = yield* resolve(api, {
        SUPABASE_AUTH_SERVICE_ROLE_KEY: "env-service-role-key",
      });

      expect(credentials.apiKey).toBe("env-service-role-key");
      expect(api.requests).toEqual([]);
    });
  });
});
