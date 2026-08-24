import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { BunServices } from "@effect/platform-bun";
import { makeApiClient } from "@supabase/api/effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { PlatformApi } from "../../auth/platform-api.service.ts";
import { mockOutput, mockStdin } from "../../../../tests/helpers/mocks.ts";
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

function testLayer(out: ReturnType<typeof mockOutput>) {
  return Layer.mergeAll(BunServices.layer, out.layer, mockStdin(true), unusedPlatformApiLayer);
}

const unusedPlatformApiLayer = Layer.effect(
  PlatformApi,
  makeApiClient({
    baseUrl: "https://api.supabase.com",
    accessToken: "unused-test-token",
  }),
).pipe(Layer.provide(httpClientLayer(() => Effect.die("unused test client"))));
const textDecoder = new TextDecoder();

function findPlatformOperationDescriptor(operationId: string) {
  const descriptor = platformOperationDescriptors.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (descriptor === undefined) {
    throw new Error(`No platform operation descriptor was found for ${operationId}.`);
  }
  return descriptor;
}

describe("platform body handling", () => {
  it.live("accepts JSON array bodies via --body", () =>
    Effect.gen(function* () {
      const descriptor = findPlatformOperationDescriptor("v1BulkCreateSecrets");
      const out = mockOutput({ format: "json" });
      let capturedInput: unknown;

      const handler = runPlatformOperation({
        descriptor,
        execute: (input) =>
          Effect.sync(() => {
            capturedInput = input;
            return { ok: true };
          }),
      });

      yield* handler({
        params: Option.some('{"ref":"abcdefghijklmnopqrst"}'),
        json: Option.none(),
        body: Option.some('[{"name":"MY_SECRET","value":"super-secret"}]'),
        bodyFile: Option.none(),
        upload: [],
        fields: Option.none(),
        schema: false,
        dryRun: false,
        yes: true,
      }).pipe(Effect.provide(testLayer(out)));

      expect(capturedInput).toEqual({
        ref: "abcdefghijklmnopqrst",
        body: [{ name: "MY_SECRET", value: "super-secret" }],
      });
    }),
  );

  it.live("accepts binary request bodies from --body-file", () =>
    Effect.gen(function* () {
      const descriptor = findPlatformOperationDescriptor("v1CreateAFunction");
      const out = mockOutput({ format: "json" });
      let capturedInput: unknown;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectory({ prefix: "platform-bodies-" });
      yield* Effect.gen(function* () {
        const filePath = path.join(tempDir, "platform-function.eszip");
        yield* fs.writeFileString(filePath, "eszip-bundle");

        const handler = runPlatformOperation({
          descriptor,
          execute: (input) =>
            Effect.sync(() => {
              capturedInput = input;
              return { ok: true };
            }),
        });

        yield* handler({
          params: Option.some('{"ref":"abcdefghijklmnopqrst","slug":"my-function"}'),
          json: Option.none(),
          body: Option.none(),
          bodyFile: Option.some(filePath),
          upload: [],
          fields: Option.none(),
          schema: false,
          dryRun: false,
          yes: true,
        }).pipe(Effect.provide(testLayer(out)));

        expect(capturedInput).toEqual(
          expect.objectContaining({
            ref: "abcdefghijklmnopqrst",
            slug: "my-function",
          }),
        );
        expect(textDecoder.decode((capturedInput as { body: Uint8Array }).body)).toBe(
          "eszip-bundle",
        );
      }).pipe(Effect.ensuring(fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore)));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("accepts multipart request bodies via --json and --upload", () =>
    Effect.gen(function* () {
      const descriptor = findPlatformOperationDescriptor("v1DeployAFunction");
      const out = mockOutput({ format: "json" });
      let capturedInput: unknown;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectory({ prefix: "platform-bodies-" });
      yield* Effect.gen(function* () {
        const firstFilePath = path.join(tempDir, "platform-function-deploy-1.eszip");
        const secondFilePath = path.join(tempDir, "platform-function-deploy-2.json");
        yield* fs.writeFileString(firstFilePath, "bundle.eszip");
        yield* fs.writeFileString(secondFilePath, "deno.json");

        const handler = runPlatformOperation({
          descriptor,
          execute: (input) =>
            Effect.sync(() => {
              capturedInput = input;
              return { ok: true };
            }),
        });

        yield* handler({
          params: Option.some('{"ref":"abcdefghijklmnopqrst","slug":"my-function"}'),
          json: Option.some('{"metadata":{"entrypoint_path":"index.ts","verify_jwt":true}}'),
          body: Option.none(),
          bodyFile: Option.none(),
          upload: [`file=${firstFilePath}`, `file=${secondFilePath}`],
          fields: Option.none(),
          schema: false,
          dryRun: false,
          yes: true,
        }).pipe(Effect.provide(testLayer(out)));

        expect(capturedInput).toEqual(
          expect.objectContaining({
            ref: "abcdefghijklmnopqrst",
            slug: "my-function",
            body: {
              metadata: {
                entrypoint_path: "index.ts",
                verify_jwt: true,
              },
              file: expect.any(Array),
            },
          }),
        );
        const files = (capturedInput as { body: { file: Uint8Array[] } }).body.file;
        expect(files.map((file) => textDecoder.decode(file))).toEqual([
          "bundle.eszip",
          "deno.json",
        ]);
      }).pipe(Effect.ensuring(fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore)));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("accepts urlencoded request bodies via --json", () =>
    Effect.gen(function* () {
      const descriptor = findPlatformOperationDescriptor("v1ExchangeOauthToken");
      const out = mockOutput({ format: "json" });
      let capturedInput: unknown;

      const handler = runPlatformOperation({
        descriptor,
        execute: (input) =>
          Effect.sync(() => {
            capturedInput = input;
            return {
              access_token: "token",
              refresh_token: "refresh",
              expires_in: 3600,
              token_type: "Bearer",
            };
          }),
      });

      yield* handler({
        params: Option.none(),
        json: Option.some('{"grant_type":"refresh_token","refresh_token":"refresh-token"}'),
        body: Option.none(),
        bodyFile: Option.none(),
        upload: [],
        fields: Option.none(),
        schema: false,
        dryRun: false,
        yes: true,
      }).pipe(Effect.provide(testLayer(out)));

      expect(capturedInput).toEqual({
        body: {
          grant_type: "refresh_token",
          refresh_token: "refresh-token",
        },
      });
    }),
  );

  it.live("renders urlencoded dry-run previews with the expected body kind", () =>
    Effect.gen(function* () {
      const descriptor = findPlatformOperationDescriptor("v1ExchangeOauthToken");
      const out = mockOutput({ format: "json" });

      const handler = runPlatformOperation({ descriptor });

      yield* handler({
        params: Option.none(),
        json: Option.some('{"grant_type":"refresh_token","refresh_token":"refresh-token"}'),
        body: Option.none(),
        bodyFile: Option.none(),
        upload: [],
        fields: Option.none(),
        schema: false,
        dryRun: true,
        yes: true,
      }).pipe(Effect.provide(testLayer(out)));

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "",
          data: expect.objectContaining({
            dryRun: true,
            bodyKind: "urlencoded",
            body: expect.objectContaining({
              grant_type: "refresh_token",
            }),
          }),
        }),
      );
    }),
  );
});
