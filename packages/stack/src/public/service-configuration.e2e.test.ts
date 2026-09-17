import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, ManagedRuntime, Path } from "effect";
import { afterAll, expect, test } from "vitest";
import type { PromiseStackConfig } from "../index.ts";
import { isolatedInstanceApi } from "../../tests/helpers/instance-api.ts";

const host = ManagedRuntime.make(NodeServices.layer);
afterAll(() => host.dispose());

const candidate = (token: string, inspectorAddress = "127.0.0.1"): PromiseStackConfig => ({
  listeners: { functionsInspector: { enabled: true, address: inspectorAddress } },
  capabilities: {
    database: { enabled: false },
    auth: { enabled: false },
    rest: { enabled: false },
    realtime: { enabled: false },
    storage: { enabled: false },
    studio: { enabled: false },
    mail: { enabled: false },
    analytics: { enabled: false },
    pooler: { enabled: false },
    functions: {
      enabled: true,
      settings: {
        functions_root: "supabase/functions",
        edge_runtime: { secrets: { CUSTOM_TOKEN: token } },
        inspector: { mode: "run" },
        functions: { hello: { enabled: true, verify_jwt: false } },
      },
    },
  },
});

test(
  "plans distinct stable API endpoints for projects with the same stack name",
  { timeout: 120_000 },
  // oxlint-disable-next-line effecttsgo/async-function -- Exercises the public Promise API and supervisor process boundary.
  async () => {
    const roots = await host.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return [
          yield* fs.makeTempDirectory({ prefix: "supabase-port-plan-first-" }),
          yield* fs.makeTempDirectory({ prefix: "supabase-port-plan-second-" }),
        ] as const;
      }),
    );
    const { createStack, openStack } = await host.runPromise(isolatedInstanceApi(roots[0]));
    const first = await createStack({
      projectRoot: roots[0],
      name: "shared-project-name",
      runtime: { kind: "native" },
      initialConfig: {},
    });
    try {
      const second = await createStack({
        projectRoot: roots[1],
        name: "shared-project-name",
        runtime: { kind: "native" },
        initialConfig: {},
      });
      try {
        expect(second.id).not.toBe(first.id);
        const firstStatus = await first.status();
        const secondStatus = await second.status();
        expect(firstStatus.endpoints.api).toBeDefined();
        expect(secondStatus.endpoints.api).toBeDefined();
        expect(secondStatus.endpoints.api?.port).not.toBe(firstStatus.endpoints.api?.port);
        const reopened = await openStack(first.id);
        expect((await reopened.status()).endpoints.api).toEqual(firstStatus.endpoints.api);
      } finally {
        await second.destroy();
      }
    } finally {
      await first.destroy();
      await host.runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          Effect.forEach(roots, (root) => fs.remove(root, { recursive: true })),
        ),
      );
    }
  },
);

test(
  "prepares candidate defaults without changing registered configuration or dynamic instances",
  { timeout: 120_000 },
  // oxlint-disable-next-line effecttsgo/async-function -- Exercises the public Promise API and supervisor process boundary.
  async () => {
    const root = await host.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({ prefix: "supabase-instance-config-" });
        const functions = path.join(root, "supabase", "functions", "hello");
        yield* fs.makeDirectory(functions, { recursive: true });
        yield* fs.writeFileString(
          path.join(functions, "index.ts"),
          'Deno.serve(() => new Response("hello"));\n',
        );
        return root;
      }),
    );
    const { createStack, openStack } = await host.runPromise(isolatedInstanceApi(root));
    const stack = await createStack({
      projectRoot: root,
      runtime: { kind: "native" },
      initialConfig: candidate("initial-secret"),
    });
    const failures: unknown[] = [];
    let stage = "default metadata";
    try {
      const functions = await stack.services.get({ name: "functions" });
      expect(functions.service).toBe("functions");
      const before = await functions.describe();
      expect(before.effectiveConfigFingerprint).toEqual(expect.any(String));
      const unchanged = await stack.prepare({
        services: [functions.id],
        config: candidate("initial-secret"),
      });
      expect(unchanged.instances[0]?.effectiveConfigFingerprint).toBe(
        before.effectiveConfigFingerprint,
      );
      const changedSecret = await stack.prepare({
        services: [functions.id],
        config: candidate("replacement-secret"),
      });
      expect(changedSecret.instances[0]?.effectiveConfigFingerprint).toEqual(expect.any(String));
      expect(changedSecret.instances[0]?.effectiveConfigFingerprint).not.toBe(
        before.effectiveConfigFingerprint,
      );
      const changedEndpoint = await stack.prepare({
        services: [functions.id],
        config: candidate("initial-secret", "127.0.0.2"),
      });
      expect(changedEndpoint.instances[0]?.effectiveConfigFingerprint).not.toBe(
        before.effectiveConfigFingerprint,
      );
      expect(await functions.describe()).toEqual(before);
      expect((await functions.status()).phase).toBe("stopped");

      stage = "dynamic preparation";
      const dynamic = await stack.services.create({
        service: "functions",
        name: "independent-functions",
        config: {
          settings: {
            functions_root: "supabase/functions",
            edge_runtime: { secrets: { CUSTOM_TOKEN: "dynamic-secret" } },
          },
        },
      });
      const dynamicBefore = await dynamic.describe();
      const preparedDynamic = await stack.prepare({
        services: [dynamic.id],
        config: candidate("replacement-secret", "127.0.0.2"),
      });
      expect(preparedDynamic.instances[0]?.effectiveConfigFingerprint).toBe(
        dynamicBefore.effectiveConfigFingerprint,
      );
      expect(await dynamic.describe()).toEqual(dynamicBefore);
      expect(await stack.prepare({ services: [] })).toEqual({ instances: [] });

      stage = "SQL endpoint metadata";
      const sqlEnabled = await stack.services.create({
        service: "database",
        name: "sql-enabled",
        config: {
          password: "matching-bootstrap-password",
          endpoints: { sql: { port: "auto" } },
        },
      });
      const sqlDisabled = await stack.services.create({
        service: "database",
        name: "sql-disabled",
        config: {
          password: "matching-bootstrap-password",
          endpoints: { sql: { enabled: false } },
        },
      });
      const enabledDescriptor = await sqlEnabled.describe();
      const disabledDescriptor = await sqlDisabled.describe();
      expect(enabledDescriptor.bootstrapInputsId).toEqual(expect.any(String));
      expect(disabledDescriptor.bootstrapInputsId).toBe(enabledDescriptor.bootstrapInputsId);
      expect(disabledDescriptor.effectiveConfigFingerprint).not.toBe(
        enabledDescriptor.effectiveConfigFingerprint,
      );

      stage = "catalog copy";
      const initialized = await stack.services.create({
        service: "database",
        name: "catalog-source",
        config: { password: "copied-profile-password" },
        initialization: { catalog: { realtime: {} } },
      });
      const copied = await stack.services.create({
        service: "database",
        name: "catalog-copy",
        config: { password: "copied-profile-password" },
        initialization: { from: initialized.id },
      });
      const sourceProfile = await initialized.describe();
      const copiedProfile = await copied.describe();
      expect(sourceProfile.initializationProfileId).toEqual(expect.any(String));
      expect(copiedProfile.initializationProfileId).toBe(sourceProfile.initializationProfileId);
      expect(copiedProfile.bootstrapInputsId).toBe(sourceProfile.bootstrapInputsId);
      expect(copiedProfile.initialization?.recipes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ service: "realtime", completed: false }),
        ]),
      );
      stage = "source destruction and copied metadata";
      await initialized.destroy();
      expect(await copied.describe()).toEqual(copiedProfile);
      await expect(
        stack.services.create({
          service: "database",
          name: "invalid-catalog-copy",
          config: {},
          initialization: { from: functions.id },
        }),
      ).rejects.toMatchObject({ _tag: "InvalidStackConfigError" });
      expect(
        (await stack.services.list()).some(({ name }) => name === "invalid-catalog-copy"),
      ).toBe(false);
      stage = "default destruction and reopening";
      await functions.destroy();
      stage = "reopen after default destruction";
      const reopened = await openStack(stack.id);
      stage = "read destroyed default";
      await expect(reopened.services.get({ name: "functions" })).rejects.toMatchObject({
        _tag: "ServiceNotFoundError",
      });
      stage = "prepare dynamic after default destruction";
      await reopened.prepare({ services: [dynamic.id], config: candidate("later-secret") });
      stage = "status after default destruction";
      expect((await reopened.status()).instances.some(({ id }) => id === functions.id)).toBe(false);
      stage = "lookup retained dynamic";
      expect((await reopened.services.get({ id: dynamic.id })).id).toBe(dynamic.id);
    } catch (error) {
      failures.push(new Error(`Configuration stage: ${stage}`, { cause: error }));
    }
    stage = "whole-stack cleanup";
    try {
      await stack.destroy();
      await expect(openStack(stack.id)).rejects.toMatchObject({ _tag: "StackNotFoundError" });
    } catch (error) {
      failures.push(new Error(`Configuration stage: ${stage}`, { cause: error }));
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        `Configuration verification failed; project retained at ${root}`,
      );
    await host.runPromise(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(root, { recursive: true })),
    );
  },
);
