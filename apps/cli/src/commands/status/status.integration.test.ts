import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { unixHttpClientLayer } from "@supabase/stack";
import { Effect, Layer } from "effect";
import { status } from "./status.handler.ts";
import {
  mockOutput,
  mockProjectLinkState,
  mockProjectLocalServiceVersions,
  withEnv,
} from "../../../tests/helpers/mocks.ts";
import {
  makeRunningStackFixture,
  makeStoppedStackFixture,
} from "../../../tests/helpers/running-stack.ts";

describe("status handler", () => {
  it.live("shows a friendly empty state when the local project has no known stacks", () => {
    const out = mockOutput();

    return Effect.gen(function* () {
      yield* status({ stack: "default" });

      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "intro", message: "Show local Supabase stack status" }),
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "outro",
          message: "No local Supabase stack is running for this project.",
        }),
      );
    }).pipe(
      Effect.provide(mockProjectLinkState()),
      Effect.provide(mockProjectLocalServiceVersions()),
      Effect.provide(out.layer),
      Effect.provide(BunServices.layer),
      Effect.provide(unixHttpClientLayer),
      Effect.provide(withEnv({})),
    );
  });

  it.live("shows stopped stack details for the current local project", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.promise(() => makeStoppedStackFixture()),
        (resource) => Effect.promise(() => resource.dispose()),
      );
      const out = mockOutput();
      const layer = Layer.mergeAll(
        fixture.baseLayer,
        out.layer,
        mockProjectLinkState({
          project: {
            ref: "abcdefghijklmnopqrst",
            name: "Alpha",
            organization_id: "org_123",
            organization_slug: "supabase",
          },
          active_branch: { ref: "abcdefghijklmnopqrst", name: "main", is_default: true },
          fetchedAt: "2026-03-25T08:00:00.000Z",
          versions: {
            postgres: "17.6.1.081",
            postgrest: "14.5",
            auth: "2.188.0-rc.15",
            storage: "1.41.8",
          },
        }),
        mockProjectLocalServiceVersions(),
      );

      yield* status({ stack: fixture.stackName }).pipe(Effect.provide(layer));

      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "info", message: "Local Supabase stack is stopped." }),
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "info", message: "Stack: default" }),
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "info", message: "Ports: API 54321, DB 54322" }),
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "info", message: "postgres version: 17.6.1.081" }),
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "Pinned stack versions are up to date.",
        }),
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "outro",
          message: "Local Supabase stack default is stopped.",
        }),
      );
    }),
  );

  it.live(
    "shows running connection details and service readiness for the current local stack",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.acquireRelease(
          Effect.promise(() => makeRunningStackFixture()),
          (resource) => Effect.promise(() => resource.dispose()),
        );
        const out = mockOutput();
        const layer = Layer.mergeAll(
          fixture.baseLayer,
          out.layer,
          mockProjectLinkState({
            project: {
              ref: "abcdefghijklmnopqrst",
              name: "Alpha",
              organization_id: "org_123",
              organization_slug: "supabase",
            },
            active_branch: { ref: "abcdefghijklmnopqrst", name: "main", is_default: true },
            fetchedAt: "2026-03-25T08:00:00.000Z",
            versions: {
              postgres: "17.6.1.081",
              postgrest: "14.5",
              auth: "2.188.0-rc.15",
              storage: "1.41.8",
            },
          }),
          mockProjectLocalServiceVersions(),
        );

        yield* status({ stack: fixture.stackName }).pipe(Effect.provide(layer));

        expect(out.messages).toContainEqual(
          expect.objectContaining({ type: "success", message: "Local Supabase stack is running." }),
        );
        expect(out.messages).toContainEqual(
          expect.objectContaining({ type: "info", message: "Stack: default" }),
        );
        expect(out.messages).toContainEqual(
          expect.objectContaining({ type: "info", message: "API URL: http://127.0.0.1:54321" }),
        );
        expect(out.messages).toContainEqual(
          expect.objectContaining({
            type: "info",
            message: "DB URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres",
          }),
        );
        expect(out.messages).toContainEqual(
          expect.objectContaining({ type: "info", message: "auth: Healthy" }),
        );
        expect(out.messages).toContainEqual(
          expect.objectContaining({ type: "info", message: "postgres: Running" }),
        );
        expect(out.messages).toContainEqual(
          expect.objectContaining({
            type: "info",
            message: "Pinned stack versions are up to date.",
          }),
        );
      }),
  );

  it.live("emits machine-readable available updates when the pinned stack is behind", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.promise(() =>
          makeStoppedStackFixture({
            services: {
              postgres: "17.6.1.081",
              postgrest: "14.5",
              auth: "2.188.0-rc.15",
              storage: "1.41.8",
            },
          }),
        ),
        (resource) => Effect.promise(() => resource.dispose()),
      );
      const out = mockOutput({ format: "json", interactive: false });
      const layer = Layer.mergeAll(
        fixture.baseLayer,
        out.layer,
        mockProjectLinkState({
          project: {
            ref: "abcdefghijklmnopqrst",
            name: "Alpha",
            organization_id: "org_123",
            organization_slug: "supabase",
          },
          active_branch: { ref: "abcdefghijklmnopqrst", name: "main", is_default: true },
          fetchedAt: "2026-03-25T08:00:00.000Z",
          versions: {
            postgres: "17.6.1.090",
            postgrest: "14.5",
            auth: "2.190.0",
            storage: "1.41.8",
          },
        }),
        mockProjectLocalServiceVersions(),
      );

      yield* status({ stack: fixture.stackName }).pipe(Effect.provide(layer));

      const successMessage = out.messages.find((message) => message.type === "success");
      expect(successMessage).toEqual(
        expect.objectContaining({
          type: "success",
          message: "Local Supabase stack is stopped.",
          data: expect.objectContaining({
            stack: "default",
            running: false,
            ports: expect.objectContaining({ apiPort: 54321, dbPort: 54322 }),
            versions: expect.objectContaining({
              postgres: "17.6.1.081",
              auth: "2.188.0-rc.15",
            }),
            up_to_date: false,
            available_updates: expect.arrayContaining([
              {
                service: "auth",
                pinned_version: "2.188.0-rc.15",
                available_version: "2.190.0",
              },
              {
                service: "postgres",
                pinned_version: "17.6.1.081",
                available_version: "17.6.1.090",
              },
            ]),
          }),
        }),
      );
    }),
  );
});
