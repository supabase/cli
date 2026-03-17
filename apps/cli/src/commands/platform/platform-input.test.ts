import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { BunServices } from "@effect/platform-bun";

import { mockOutput, mockStdin } from "../../../tests/helpers/mocks.ts";
import { NonInteractiveError } from "../../output/errors.ts";
import { Output } from "../../output/output.service.ts";
import { platformOperationDescriptors } from "./platform-descriptors.ts";
import {
  decodePlatformInput,
  mergePlatformInput,
  parsePlatformBodySource,
  parsePlatformUploadSources,
  promptForMissingPlatformFields,
  validatePlatformStdinUsage,
} from "./platform-input.ts";
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

const createProjectDescriptor = findPlatformOperationDescriptor("v1CreateAProject");
const bulkSecretsDescriptor = findPlatformOperationDescriptor("v1BulkCreateSecrets");
const deleteBranchDescriptor = findPlatformOperationDescriptor("v1DeleteABranch");
const deployFunctionDescriptor = findPlatformOperationDescriptor("v1DeployAFunction");
const exchangeOauthTokenDescriptor = findPlatformOperationDescriptor("v1ExchangeOauthToken");
const createFunctionDescriptor = findPlatformOperationDescriptor("v1CreateAFunction");
const generateTypescriptTypesDescriptor = findPlatformOperationDescriptor(
  "v1GenerateTypescriptTypes",
);

function getFailError(exit: Exit.Exit<unknown, unknown>): unknown {
  if (!Exit.isFailure(exit)) {
    throw new Error("Expected a failure");
  }
  const fail = exit.cause.reasons.find(Cause.isFailReason);
  if (!fail) {
    throw new Error("Expected a failure reason");
  }
  return fail.error;
}

describe("platform input", () => {
  it.effect("merges params, json, and flags with flags winning", () =>
    Effect.gen(function* () {
      const merged = yield* mergePlatformInput({
        descriptor: createProjectDescriptor,
        jsonValues: Option.some({ name: "from-json" }),
        paramsValues: Option.none(),
        bodyValue: Option.none(),
        uploadValues: Option.none(),
      });

      expect(merged).toEqual({
        name: "from-json",
      });
    }),
  );

  it.effect("fails when json contains a non-body field", () =>
    Effect.gen(function* () {
      const exit = yield* mergePlatformInput({
        descriptor: createProjectDescriptor,
        jsonValues: Option.some({ ref: "proj-1" }),
        paramsValues: Option.none(),
        bodyValue: Option.none(),
        uploadValues: Option.none(),
      }).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("suggests the exact schema command for unexpected json fields", () =>
    Effect.gen(function* () {
      const exit = yield* mergePlatformInput({
        descriptor: createProjectDescriptor,
        jsonValues: Option.some({ organization_slu: "french-bakery" }),
        paramsValues: Option.none(),
        bodyValue: Option.none(),
        uploadValues: Option.none(),
      }).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(getFailError(exit)).toEqual(
        expect.objectContaining({
          _tag: "PlatformInputError",
          message: "Unexpected field(s) in --json.",
          detail: "organization_slu",
          suggestion:
            "Run `supabase platform schema projects.create` or re-run `supabase platform projects create --schema` to inspect the supported request shape.",
        }),
      );
    }),
  );

  it.effect("suggests --params when a params-only command receives --json", () =>
    Effect.gen(function* () {
      const exit = yield* mergePlatformInput({
        descriptor: generateTypescriptTypesDescriptor,
        jsonValues: Option.some({ ref: "foo" }),
        paramsValues: Option.none(),
        bodyValue: Option.none(),
        uploadValues: Option.none(),
      }).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(getFailError(exit)).toEqual(
        expect.objectContaining({
          _tag: "PlatformInputError",
          message: "This command does not accept --json.",
          suggestion: "Use `--params` for path, query, or header input.",
        }),
      );
    }),
  );

  it.effect("merges non-object request bodies under the SDK body field", () =>
    Effect.gen(function* () {
      const merged = yield* mergePlatformInput({
        descriptor: bulkSecretsDescriptor,
        jsonValues: Option.none(),
        paramsValues: Option.some({ ref: "abcdefghijklmnopqrst" }),
        bodyValue: Option.some([{ name: "MY_SECRET", value: "secret-value" }]),
        uploadValues: Option.none(),
      });

      expect(merged).toEqual({
        ref: "abcdefghijklmnopqrst",
        body: [{ name: "MY_SECRET", value: "secret-value" }],
      });
    }),
  );

  it.effect("merges urlencoded object bodies under the SDK body field", () =>
    Effect.gen(function* () {
      const merged = yield* mergePlatformInput({
        descriptor: exchangeOauthTokenDescriptor,
        jsonValues: Option.some({
          grant_type: "refresh_token",
          refresh_token: "token-123",
        }),
        paramsValues: Option.none(),
        bodyValue: Option.none(),
        uploadValues: Option.none(),
      });

      expect(merged).toEqual({
        body: {
          grant_type: "refresh_token",
          refresh_token: "token-123",
        },
      });
    }),
  );

  it.effect("parses binary bodies from --body-file", () =>
    Effect.gen(function* () {
      const filePath = "/tmp/platform-input-function.eszip";
      yield* Effect.promise(() => Bun.write(filePath, "eszip-bundle"));

      const body = yield* parsePlatformBodySource(
        {
          body: Option.none(),
          bodyFile: Option.some(filePath),
        },
        createFunctionDescriptor.request.body,
      );

      expect(Option.isSome(body)).toBe(true);
      if (Option.isSome(body)) {
        expect(textDecoder.decode(body.value as Uint8Array)).toBe("eszip-bundle");
      }
    }).pipe(Effect.provide(BunServices.layer), Effect.provide(mockStdin(true))),
  );

  it.effect("parses multipart binary upload flags into grouped arrays", () =>
    Effect.gen(function* () {
      const firstFilePath = "/tmp/platform-input-deploy-1.eszip";
      const secondFilePath = "/tmp/platform-input-deploy-2.json";
      yield* Effect.promise(() => Bun.write(firstFilePath, "bundle.eszip"));
      yield* Effect.promise(() => Bun.write(secondFilePath, "deno.json"));

      const uploads = yield* parsePlatformUploadSources(
        [`file=${firstFilePath}`, `file=${secondFilePath}`],
        deployFunctionDescriptor.request.body,
      );

      expect(Option.isSome(uploads)).toBe(true);
      if (Option.isSome(uploads)) {
        expect(uploads.value).toEqual(
          expect.objectContaining({
            file: expect.any(Array),
          }),
        );
        const files = (uploads.value as { file: Uint8Array[] }).file;
        expect(files.map((file) => textDecoder.decode(file))).toEqual([
          "bundle.eszip",
          "deno.json",
        ]);
      }
    }).pipe(Effect.provide(BunServices.layer), Effect.provide(mockStdin(true))),
  );

  it.effect("rejects unknown multipart upload fields", () =>
    Effect.gen(function* () {
      const exit = yield* parsePlatformUploadSources(
        ["missing=/tmp/bundle.eszip"],
        deployFunctionDescriptor.request.body,
      ).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(getFailError(exit)).toEqual(
        expect.objectContaining({
          _tag: "PlatformInputError",
          message: "Invalid --upload value.",
          detail: "Unknown multipart upload field: missing",
        }),
      );
    }).pipe(Effect.provide(BunServices.layer), Effect.provide(mockStdin(true))),
  );

  it.effect("rejects uploads targeting structured multipart fields", () =>
    Effect.gen(function* () {
      const exit = yield* parsePlatformUploadSources(
        ["metadata=/tmp/bundle.eszip"],
        deployFunctionDescriptor.request.body,
      ).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(getFailError(exit)).toEqual(
        expect.objectContaining({
          _tag: "PlatformInputError",
          message: "Invalid --upload value.",
          detail: "metadata is not a binary multipart field.",
        }),
      );
    }).pipe(Effect.provide(BunServices.layer), Effect.provide(mockStdin(true))),
  );

  it.effect("rejects multiple stdin consumers across flags and uploads", () =>
    Effect.gen(function* () {
      const exit = yield* validatePlatformStdinUsage(
        Option.some("-"),
        Option.none(),
        Option.none(),
        ["file=-"],
      ).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(getFailError(exit)).toEqual(
        expect.objectContaining({
          _tag: "PlatformInputError",
          message:
            "Only one of --json, --params, --body, or --upload can read from stdin in the same command.",
        }),
      );
    }),
  );

  it.effect("explains raw byte file lookup failures with --body-file", () =>
    Effect.gen(function* () {
      const exit = yield* parsePlatformBodySource(
        {
          body: Option.none(),
          bodyFile: Option.some("/tmp/does-not-exist.eszip"),
        },
        createFunctionDescriptor.request.body,
      ).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(getFailError(exit)).toEqual(
        expect.objectContaining({
          _tag: "PlatformInputError",
          message: "Invalid request body input.",
          detail: "File not found: /tmp/does-not-exist.eszip",
          suggestion: "Check the path passed to --body-file.",
        }),
      );
    }).pipe(Effect.provide(BunServices.layer), Effect.provide(mockStdin(true))),
  );

  it.effect("uses the exact command in schema mismatch suggestions", () =>
    Effect.gen(function* () {
      const exit = yield* decodePlatformInput(
        deleteBranchDescriptor,
        deleteBranchDescriptor.inputSchema,
        { branch_id_or_ref: 123 },
      ).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(getFailError(exit)).toEqual(
        expect.objectContaining({
          _tag: "PlatformInputError",
          message: "The request payload does not match the operation schema.",
          detail: expect.stringContaining("Expected"),
          suggestion:
            "Run `supabase platform schema branches.delete` or re-run `supabase platform branches delete --schema` to inspect the documented request and response shape.",
        }),
      );
    }),
  );

  it.live("prompts for missing required fields in text mode", () => {
    const out = mockOutput({ format: "text" });
    return Effect.gen(function* () {
      const completed = yield* promptForMissingPlatformFields(createProjectDescriptor, {});
      expect(completed).toEqual({
        db_pass: "",
        name: "123456",
        organization_slug: "123456",
      });
    }).pipe(Effect.provide(out.layer), Effect.provide(mockStdin(true)));
  });

  it.live("prompts string-only union params as plain text", () => {
    const prompts: string[] = [];
    const out = Layer.succeed(Output, {
      format: "text" as const,
      interactive: true,
      intro: () => Effect.void,
      outro: () => Effect.void,
      info: () => Effect.void,
      warn: () => Effect.void,
      error: () => Effect.void,
      event: () => Effect.void,
      task: () =>
        Effect.succeed({
          message: () => Effect.void,
          succeed: () => Effect.void,
          fail: () => Effect.void,
          info: () => Effect.void,
          cancel: () => Effect.void,
          clear: () => Effect.void,
        }),
      promptText: (message, options) =>
        Effect.sync(() => {
          prompts.push(message);
          const validationError = options?.validate?.("branch-ref");
          if (validationError !== undefined) {
            throw new Error(`Unexpected validation error: ${validationError}`);
          }
          return "branch-ref";
        }),
      promptPassword: () => Effect.succeed(""),
      promptConfirm: () => Effect.succeed(true),
      promptSelect: (_message, options) => Effect.succeed(options[0]!.value),
      promptMultiSelect: (_message, options) =>
        Effect.succeed(options.map((option) => option.value)),
      progress: () =>
        Effect.succeed({
          start: () => Effect.void,
          advance: () => Effect.void,
          message: () => Effect.void,
          stop: () => Effect.void,
        }),
      success: () => Effect.void,
      fail: () => Effect.void,
    });

    return Effect.gen(function* () {
      const completed = yield* promptForMissingPlatformFields(deleteBranchDescriptor, {});
      expect(completed).toEqual({
        branch_id_or_ref: "branch-ref",
      });
      expect(prompts).toEqual(["Branch Id Or Ref"]);
    }).pipe(Effect.provide(out), Effect.provide(mockStdin(true)));
  });

  it.live("refuses to prompt in json mode", () => {
    const out = mockOutput({ format: "json" });
    return Effect.gen(function* () {
      const exit = yield* promptForMissingPlatformFields(createProjectDescriptor, {}).pipe(
        Effect.exit,
      );
      expect(getFailError(exit)).toBeInstanceOf(NonInteractiveError);
    }).pipe(Effect.provide(out.layer), Effect.provide(mockStdin(true)));
  });
});
