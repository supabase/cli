import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import { BunServices } from "@effect/platform-bun";
import { SupabaseApiClient } from "@supabase/api/effect";

import { mockOutput, mockStdin } from "../../../tests/helpers/mocks.ts";
import { platformOperationDescriptors } from "./platform-descriptors.ts";
import { runPlatformOperation } from "./platform-handler.ts";

const unusedApiClientLayer = Layer.succeed(SupabaseApiClient, {
  execute: () => Effect.die("unused test client"),
});

function findPlatformOperationDescriptor(operationId: string) {
  const descriptor = platformOperationDescriptors.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (descriptor === undefined) {
    throw new Error(`No platform operation descriptor was found for ${operationId}.`);
  }
  return descriptor;
}

describe("projects create platform handler", () => {
  it("decodes --json input and projects response fields", async () => {
    const descriptor = findPlatformOperationDescriptor("v1CreateAProject");
    const out = mockOutput({ format: "json" });
    let capturedInput: unknown;

    const handler = runPlatformOperation({
      descriptor,
      execute: (input) =>
        Effect.sync(() => {
          capturedInput = input;
          return {
            id: "project-id",
            ref: "abcd1234",
            organization_id: "org-id",
            organization_slug: "my-org",
            name: "json-name",
            region: "us-east-1",
            created_at: "2026-03-13T10:00:00.000Z",
            status: "ACTIVE_HEALTHY",
          };
        }),
    });

    await Effect.runPromise(
      handler({
        params: Option.none(),
        json: Option.some(
          JSON.stringify({
            name: "json-name",
            db_pass: "json-password",
            organization_slug: "my-org",
          }),
        ),
        body: Option.none(),
        bodyFile: Option.none(),
        upload: [],
        fields: Option.some("ref,status"),
        schema: false,
        dryRun: false,
        yes: true,
      }).pipe(
        Effect.provide(out.layer),
        Effect.provide(mockStdin(true)),
        Effect.provide(unusedApiClientLayer),
        Effect.provide(BunServices.layer),
      ),
    );

    expect(capturedInput).toEqual({
      name: "json-name",
      db_pass: "json-password",
      organization_slug: "my-org",
    });
    expect(out.messages).toContainEqual(
      expect.objectContaining({
        type: "success",
        message: "",
        data: { ref: "abcd1234", status: "ACTIVE_HEALTHY" },
      }),
    );
  });

  it("renders schema without executing the operation", async () => {
    const descriptor = findPlatformOperationDescriptor("v1CreateAProject");
    const out = mockOutput({ format: "json" });
    let executed = false;

    const handler = runPlatformOperation({
      descriptor,
      execute: (_input) =>
        Effect.sync(() => {
          executed = true;
          return {
            id: "project-id",
          };
        }),
    });

    await Effect.runPromise(
      handler({
        params: Option.none(),
        json: Option.none(),
        body: Option.none(),
        bodyFile: Option.none(),
        upload: [],
        fields: Option.none(),
        schema: true,
        dryRun: false,
        yes: true,
      }).pipe(
        Effect.provide(out.layer),
        Effect.provide(mockStdin(true)),
        Effect.provide(unusedApiClientLayer),
        Effect.provide(BunServices.layer),
      ),
    );

    expect(executed).toBe(false);
    expect(out.messages).toContainEqual(
      expect.objectContaining({
        type: "success",
        message: "",
        data: expect.objectContaining({
          method: "projects.create",
          command: "supabase platform projects create",
          request: expect.objectContaining({
            body: expect.objectContaining({
              kind: "json",
            }),
          }),
        }),
      }),
    );
  });

  it("renders text schema output without a success banner", async () => {
    const descriptor = findPlatformOperationDescriptor("v1CreateAProject");
    const out = mockOutput({ format: "text" });
    let executed = false;

    const handler = runPlatformOperation({
      descriptor,
      execute: () =>
        Effect.sync(() => {
          executed = true;
          return {
            id: "project-id",
          };
        }),
    });

    await Effect.runPromise(
      handler({
        params: Option.none(),
        json: Option.none(),
        body: Option.none(),
        bodyFile: Option.none(),
        upload: [],
        fields: Option.none(),
        schema: true,
        dryRun: false,
        yes: true,
      }).pipe(
        Effect.provide(out.layer),
        Effect.provide(mockStdin(true)),
        Effect.provide(unusedApiClientLayer),
        Effect.provide(BunServices.layer),
      ),
    );

    expect(executed).toBe(false);
    expect(
      out.messages.some(
        (message) => message.type === "success" && message.message === "Schema loaded.",
      ),
    ).toBe(false);
    expect(out.messages).toContainEqual(
      expect.objectContaining({
        type: "info",
        message: expect.stringContaining("method: projects.create"),
      }),
    );
  });

  it("renders text dry-run previews without a success banner", async () => {
    const descriptor = findPlatformOperationDescriptor("v1CreateAProject");
    const out = mockOutput({ format: "text" });
    let executed = false;

    const handler = runPlatformOperation({
      descriptor,
      execute: () =>
        Effect.sync(() => {
          executed = true;
          return { id: "project-id" };
        }),
    });

    await Effect.runPromise(
      handler({
        params: Option.none(),
        json: Option.some(
          JSON.stringify({
            name: "preview-name",
            db_pass: "super-secret",
            organization_slug: "my-org",
          }),
        ),
        body: Option.none(),
        bodyFile: Option.none(),
        upload: [],
        fields: Option.none(),
        schema: false,
        dryRun: true,
        yes: true,
      }).pipe(
        Effect.provide(out.layer),
        Effect.provide(mockStdin(true)),
        Effect.provide(unusedApiClientLayer),
        Effect.provide(BunServices.layer),
      ),
    );

    expect(executed).toBe(false);
    expect(
      out.messages.some(
        (message) => message.type === "success" && message.message === "Dry run complete.",
      ),
    ).toBe(false);
    expect(out.messages).toContainEqual(
      expect.objectContaining({
        type: "info",
        message: expect.stringContaining("db_pass: <redacted>"),
      }),
    );
    expect(out.messages).toContainEqual(
      expect.objectContaining({
        type: "info",
        message: expect.stringContaining("name: preview-name"),
      }),
    );
  });

  it("omits the generic success banner for structured text responses", async () => {
    const descriptor = findPlatformOperationDescriptor("v1ListAllOrganizations");
    const out = mockOutput({ format: "text" });

    const handler = runPlatformOperation({
      descriptor,
      execute: () =>
        Effect.sync(() => [
          {
            id: "supabase",
            slug: "supabase",
            name: "Supabase",
          },
        ]),
    });

    await Effect.runPromise(
      handler({
        params: Option.none(),
        json: Option.none(),
        body: Option.none(),
        bodyFile: Option.none(),
        upload: [],
        fields: Option.none(),
        schema: false,
        dryRun: false,
        yes: true,
      }).pipe(
        Effect.provide(out.layer),
        Effect.provide(mockStdin(true)),
        Effect.provide(unusedApiClientLayer),
        Effect.provide(BunServices.layer),
      ),
    );

    expect(
      out.messages.some(
        (message) => message.type === "success" && message.message === "Request completed.",
      ),
    ).toBe(false);
    expect(out.messages).toContainEqual(
      expect.objectContaining({
        type: "success",
        message: expect.stringContaining("- id: supabase"),
      }),
    );
  });
});
