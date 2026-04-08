import { describe, expect, it } from "vitest";
import { Effect, Exit, Layer, Option, Sink, Stream } from "effect";
import { BunServices } from "@effect/platform-bun";
import { makeApiClient } from "@supabase/api/effect";
import * as Stdio from "effect/Stdio";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { PlatformApi } from "../../auth/platform-api.service.ts";
import { mockOutput, mockStdin } from "../../../tests/helpers/mocks.ts";
import { platformOperationDescriptors } from "./platform-descriptors.ts";
import { runPlatformOperation } from "./platform-handler.ts";

function httpClientLayer(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  );
}

const unusedPlatformApiLayer = Layer.effect(
  PlatformApi,
  makeApiClient({
    baseUrl: "https://api.supabase.com",
    accessToken: "unused-test-token",
  }),
).pipe(Layer.provide(httpClientLayer(() => Effect.die("unused test client"))));

function findPlatformOperationDescriptor(operationId: string) {
  const descriptor = platformOperationDescriptors.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (descriptor === undefined) {
    throw new Error(`No platform operation descriptor was found for ${operationId}.`);
  }
  return descriptor;
}

function mockStdio() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const layer = Layer.succeed(
    Stdio.Stdio,
    Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.empty,
      stdout: () =>
        Sink.forEach((item: string | Uint8Array) =>
          Effect.sync(() => {
            stdout.push(typeof item === "string" ? item : new TextDecoder().decode(item));
          }),
        ),
      stderr: () =>
        Sink.forEach((item: string | Uint8Array) =>
          Effect.sync(() => {
            stderr.push(typeof item === "string" ? item : new TextDecoder().decode(item));
          }),
        ),
    }),
  );
  return { layer, stdout, stderr };
}

describe("projects create platform handler", () => {
  it("supports inline --json with dry-run output", async () => {
    const descriptor = findPlatformOperationDescriptor("v1CreateAProject");
    const out = mockOutput({ format: "json" });

    const handler = runPlatformOperation({ descriptor });

    await Effect.runPromise(
      handler({
        params: Option.none(),
        json: Option.some(
          JSON.stringify({
            name: "from-inline",
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
        Effect.provide(unusedPlatformApiLayer),
        Effect.provide(BunServices.layer),
      ),
    );

    expect(out.messages).toContainEqual(
      expect.objectContaining({
        type: "success",
        message: "",
        data: expect.objectContaining({
          dryRun: true,
          json: expect.objectContaining({
            name: "from-inline",
            db_pass: "<redacted>",
          }),
        }),
      }),
    );
  });

  it("supports stdin-backed --json with dry-run output", async () => {
    const descriptor = findPlatformOperationDescriptor("v1CreateAProject");
    const out = mockOutput({ format: "json" });

    const handler = runPlatformOperation({ descriptor });

    await Effect.runPromise(
      handler({
        params: Option.none(),
        json: Option.some("-"),
        body: Option.none(),
        bodyFile: Option.none(),
        upload: [],
        fields: Option.none(),
        schema: false,
        dryRun: true,
        yes: true,
      }).pipe(
        Effect.provide(out.layer),
        Effect.provide(
          mockStdin(
            true,
            '{"name":"from-stdin","db_pass":"stdin-secret","organization_slug":"my-org"}',
          ),
        ),
        Effect.provide(unusedPlatformApiLayer),
        Effect.provide(BunServices.layer),
      ),
    );

    expect(out.messages).toContainEqual(
      expect.objectContaining({
        type: "success",
        message: "",
        data: expect.objectContaining({
          dryRun: true,
          json: expect.objectContaining({
            name: "from-stdin",
            db_pass: "<redacted>",
          }),
        }),
      }),
    );
  });

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
        Effect.provide(unusedPlatformApiLayer),
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
    const stdio = mockStdio();
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
        Effect.provide(stdio.layer),
        Effect.provide(mockStdin(true)),
        Effect.provide(unusedPlatformApiLayer),
        Effect.provide(BunServices.layer),
      ),
    );

    expect(executed).toBe(false);
    expect(out.messages).toEqual([]);
    expect(JSON.parse(stdio.stdout.join(""))).toEqual(
      expect.objectContaining({
        route: "/v1/projects",
        method: "POST",
        command: "supabase api request /v1/projects --method POST",
        input: expect.objectContaining({
          body: expect.objectContaining({
            kind: "json",
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
        Effect.provide(unusedPlatformApiLayer),
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
        message: expect.stringContaining("Route\n  POST /v1/projects"),
      }),
    );
  });

  it("emits schema payloads as result events in stream-json mode", async () => {
    const descriptor = findPlatformOperationDescriptor("v1CreateAProject");
    const out = mockOutput({ format: "stream-json", interactive: false });
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
        Effect.provide(unusedPlatformApiLayer),
        Effect.provide(BunServices.layer),
      ),
    );

    expect(executed).toBe(false);
    expect(out.events).toContainEqual(
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({
          route: "/v1/projects",
          method: "POST",
          input: expect.objectContaining({
            body: expect.objectContaining({
              kind: "json",
            }),
          }),
        }),
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
        Effect.provide(unusedPlatformApiLayer),
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
        Effect.provide(unusedPlatformApiLayer),
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

  it("returns a structured non-interactive error when required values are missing", async () => {
    const descriptor = findPlatformOperationDescriptor("v1CreateAProject");
    const out = mockOutput({ format: "json", interactive: false });

    const handler = runPlatformOperation({ descriptor });

    const exit = await Effect.runPromise(
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
        Effect.provide(mockStdin(false)),
        Effect.provide(unusedPlatformApiLayer),
        Effect.provide(BunServices.layer),
        Effect.exit,
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });
});
