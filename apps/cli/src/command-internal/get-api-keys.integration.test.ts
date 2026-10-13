import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { VALID_REF, mockCommandPlatformApi } from "../../tests/helpers/command-mocks.ts";
import { assertDriftAgainst } from "../../tests/helpers/permission-drift.ts";
import { getProjectApiKeys, projectApiKeys } from "./get-api-keys.ts";
import { mapped } from "./command-permissions/model.ts";

const declared = { _tag: "Declared", permissions: mapped(projectApiKeys) } as const;
const apiKeys = [{ name: "anon", api_key: "anon-key", type: "legacy" }];
const apiKeysUrl = `https://api.supabase.com/v1/projects/${VALID_REF}/api-keys`;

describe("getProjectApiKeys", () => {
  it.live("requests the project api-keys with reveal=true only when asked for secret keys", () =>
    Effect.gen(function* () {
      const revealed = mockCommandPlatformApi({ response: { status: 200, body: apiKeys } });
      const plain = mockCommandPlatformApi({ response: { status: 200, body: apiKeys } });

      const keys = yield* getProjectApiKeys(VALID_REF, true).pipe(
        Effect.provide(revealed.factoryLayer),
      );
      yield* getProjectApiKeys(VALID_REF).pipe(Effect.provide(plain.factoryLayer));

      expect(keys).toEqual(apiKeys);
      expect(revealed.requests.map((request) => request.urlParams)).toEqual(["reveal=true"]);
      expect(plain.requests.map((request) => request.urlParams)).toEqual([""]);
      for (const { requests } of [revealed, plain]) {
        expect(requests.map((request) => request.url)).toEqual([apiKeysUrl]);
        assertDriftAgainst(declared, {
          command: "project-api-keys block",
          activeFlags: {},
          requests,
          exact: true,
        });
      }
    }),
  );
});
