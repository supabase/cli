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
  it("accepts JSON array bodies via --body", async () => {
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

    await Effect.runPromise(
      handler({
        params: Option.some('{"ref":"abcdefghijklmnopqrst"}'),
        json: Option.none(),
        body: Option.some('[{"name":"MY_SECRET","value":"super-secret"}]'),
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

    expect(capturedInput).toEqual({
      ref: "abcdefghijklmnopqrst",
      body: [{ name: "MY_SECRET", value: "super-secret" }],
    });
  });

  it("accepts binary request bodies from --body-file", async () => {
    const descriptor = findPlatformOperationDescriptor("v1CreateAFunction");
    const out = mockOutput({ format: "json" });
    let capturedInput: unknown;
    const filePath = "/tmp/platform-function.eszip";
    await Bun.write(filePath, "eszip-bundle");

    const handler = runPlatformOperation({
      descriptor,
      execute: (input) =>
        Effect.sync(() => {
          capturedInput = input;
          return { ok: true };
        }),
    });

    await Effect.runPromise(
      handler({
        params: Option.some('{"ref":"abcdefghijklmnopqrst","slug":"my-function"}'),
        json: Option.none(),
        body: Option.none(),
        bodyFile: Option.some(filePath),
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

    expect(capturedInput).toEqual(
      expect.objectContaining({
        ref: "abcdefghijklmnopqrst",
        slug: "my-function",
      }),
    );
    expect(textDecoder.decode((capturedInput as { body: Uint8Array }).body)).toBe("eszip-bundle");
  });

  it("accepts multipart request bodies via --json and --upload", async () => {
    const descriptor = findPlatformOperationDescriptor("v1DeployAFunction");
    const out = mockOutput({ format: "json" });
    let capturedInput: unknown;
    const firstFilePath = "/tmp/platform-function-deploy-1.eszip";
    const secondFilePath = "/tmp/platform-function-deploy-2.json";
    await Bun.write(firstFilePath, "bundle.eszip");
    await Bun.write(secondFilePath, "deno.json");

    const handler = runPlatformOperation({
      descriptor,
      execute: (input) =>
        Effect.sync(() => {
          capturedInput = input;
          return { ok: true };
        }),
    });

    await Effect.runPromise(
      handler({
        params: Option.some('{"ref":"abcdefghijklmnopqrst","slug":"my-function"}'),
        json: Option.some('{"metadata":{"entrypoint_path":"index.ts","verify_jwt":true}}'),
        body: Option.none(),
        bodyFile: Option.none(),
        upload: [`file=${firstFilePath}`, `file=${secondFilePath}`],
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
    expect(files.map((file) => textDecoder.decode(file))).toEqual(["bundle.eszip", "deno.json"]);
  });

  it("accepts urlencoded request bodies via --json", async () => {
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

    await Effect.runPromise(
      handler({
        params: Option.none(),
        json: Option.some('{"grant_type":"refresh_token","refresh_token":"refresh-token"}'),
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

    expect(capturedInput).toEqual({
      body: {
        grant_type: "refresh_token",
        refresh_token: "refresh-token",
      },
    });
  });
});
