import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, vi } from "vitest";

import {
  VALID_REF,
  mockCommandPlatformApi,
  mockCommandSettings,
} from "../../tests/helpers/command-mocks.ts";
import { mockRuntimeInfo } from "../../tests/helpers/mocks.ts";
import { assertDriftAgainst } from "../../tests/helpers/permission-drift.ts";
import { unusedStackServices } from "../../tests/helpers/unused-stack.ts";
import { storageCredentials } from "./command-permissions/fragments.ts";
import { mapped } from "./command-permissions/model.ts";
import { resolveStorageCredentials } from "./storage-credentials.ts";

const declared = { _tag: "Declared", permissions: mapped(storageCredentials) } as const;
const apiKeys = [
  { name: "anon", api_key: "anon-key", type: "legacy" },
  { name: "service_role", api_key: "service-role-key", type: "legacy" },
];
const config = { api: { enabled: true, port: 54321, tls: { enabled: false } }, auth: {} };

describe("resolveStorageCredentials for a remote project", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const resolve = (api: ReturnType<typeof mockCommandPlatformApi>) =>
    resolveStorageCredentials({ projectRef: VALID_REF, config }).pipe(
      Effect.provide(
        Layer.mergeAll(
          api.factoryLayer,
          mockCommandSettings({ workdir: "/unused" }),
          mockRuntimeInfo(),
          unusedStackServices,
          BunServices.layer,
        ),
      ),
    );

  it.live("fetches the service-role key from the project api-keys without an env override", () => {
    vi.stubEnv("SUPABASE_AUTH_SERVICE_ROLE_KEY", undefined);
    const api = mockCommandPlatformApi({ response: { status: 200, body: apiKeys } });
    return Effect.gen(function* () {
      const credentials = yield* resolve(api);

      expect(credentials.apiKey).toBe("service-role-key");
      expect(api.requests.map((request) => request.urlParams)).toEqual(["reveal=true"]);
      assertDriftAgainst(declared, {
        command: "storage-credentials block",
        activeFlags: {},
        requests: api.requests,
      });
    });
  });

  it.live("requests no api-keys when SUPABASE_AUTH_SERVICE_ROLE_KEY is set", () => {
    vi.stubEnv("SUPABASE_AUTH_SERVICE_ROLE_KEY", "env-service-role-key");
    const api = mockCommandPlatformApi({ response: { status: 200, body: apiKeys } });
    return Effect.gen(function* () {
      const credentials = yield* resolve(api);

      expect(credentials.apiKey).toBe("env-service-role-key");
      expect(api.requests).toEqual([]);
    });
  });
});
