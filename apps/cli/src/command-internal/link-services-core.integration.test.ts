import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  VALID_REF,
  mockCommandPlatformApi,
  mockCommandSettings,
  useTempWorkdir,
} from "../../tests/helpers/command-mocks.ts";
import { assertDriftAgainst } from "../../tests/helpers/permission-drift.ts";
import { linkServices } from "./command-permissions/fragments.ts";
import { mapped } from "./command-permissions/model.ts";
import { linkServicesCore } from "./link-services-core.ts";

const declared = { _tag: "Declared", permissions: mapped(linkServices) } as const;
const storageConfigUrl = `https://api.supabase.com/v1/projects/${VALID_REF}/config/storage`;
const poolerConfigUrl = `https://api.supabase.com/v1/projects/${VALID_REF}/config/database/pooler`;

describe("linkServicesCore", () => {
  const workdir = useTempWorkdir("link-services-");

  const run = (skipPooler: boolean) => {
    const api = mockCommandPlatformApi();
    return linkServicesCore({
      ref: VALID_REF,
      serviceKey: "service-key",
      skipPooler,
      workdir: workdir.current,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          api.layer,
          api.httpClientLayer,
          mockCommandSettings({ workdir: workdir.current }),
        ).pipe(Layer.provideMerge(BunServices.layer)),
      ),
      Effect.as(api.requests),
    );
  };

  it.live("requests the storage and pooler configs of the linked project", () =>
    Effect.gen(function* () {
      const requests = yield* run(false);

      const urls = requests.map((request) => request.url);
      expect(urls).toContain(storageConfigUrl);
      expect(urls).toContain(poolerConfigUrl);
      assertDriftAgainst(declared, {
        command: "link-services block",
        activeFlags: {},
        requests,
      });
    }),
  );

  it.live("requests no pooler config when skipPooler is set", () =>
    Effect.gen(function* () {
      const requests = yield* run(true);

      const urls = requests.map((request) => request.url);
      expect(urls).toContain(storageConfigUrl);
      expect(urls).not.toContain(poolerConfigUrl);
      assertDriftAgainst(declared, {
        command: "link-services block",
        activeFlags: { "skip-pooler": true },
        requests,
      });
    }),
  );
});
