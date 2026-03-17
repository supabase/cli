import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";

import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { PlatformMethodNotFoundError } from "./platform.errors.ts";
import { platformOperationDescriptors } from "./platform-descriptors.ts";
import { showPlatformSchema } from "./platform-schema.handler.ts";

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

function methodNameFor(operationId: string): string {
  const descriptor = platformOperationDescriptors.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (descriptor === undefined) {
    throw new Error(`No platform operation descriptor was found for ${operationId}.`);
  }
  return descriptor.commandPath.slice(1).join(".");
}

describe("platform schema handler", () => {
  it.live("renders the schema payload in json mode", () => {
    const out = mockOutput({ format: "json" });

    return Effect.gen(function* () {
      yield* showPlatformSchema("projects.create");

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "",
          data: expect.objectContaining({
            method: "projects.create",
            command: "supabase platform projects create",
            http: {
              method: "POST",
              path: "/v1/projects",
            },
            request: expect.objectContaining({
              body: expect.objectContaining({
                kind: "json",
                schema: expect.objectContaining({
                  kind: "object",
                  properties: expect.arrayContaining([
                    expect.objectContaining({ name: "db_pass", sensitive: true }),
                    expect.objectContaining({ name: "organization_slug", required: true }),
                    expect.objectContaining({
                      name: "region_selection",
                      kind: "union",
                    }),
                  ]),
                }),
              }),
            }),
            inputHelp: expect.objectContaining({
              body: expect.objectContaining({
                summary: "Use `--json` for object-shaped JSON request bodies.",
              }),
            }),
            examples: expect.arrayContaining([
              expect.objectContaining({
                command: expect.stringContaining("--json"),
              }),
            ]),
            response: expect.objectContaining({
              kind: "object",
              properties: expect.arrayContaining([
                expect.objectContaining({ name: "status", kind: "enum" }),
              ]),
            }),
            projection: {
              flag: "--fields",
              available: expect.arrayContaining(["id", "ref", "status"]),
            },
          }),
        }),
      );
    }).pipe(Effect.provide(out.layer));
  });

  it.live("includes binary input guidance and examples in schema output", () => {
    const out = mockOutput({ format: "json" });

    return Effect.gen(function* () {
      yield* showPlatformSchema(methodNameFor("v1CreateAFunction"));

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "",
          data: expect.objectContaining({
            method: "projects.functions.create",
            inputHelp: expect.objectContaining({
              body: expect.objectContaining({
                summary: "This request body expects raw bytes.",
                notes: expect.arrayContaining([
                  "Use `--body-file <path>` to read bytes from a filesystem path.",
                ]),
                examples: expect.arrayContaining([
                  expect.objectContaining({
                    command: expect.stringContaining("--body-file ./body.bin"),
                  }),
                ]),
              }),
            }),
          }),
        }),
      );
    }).pipe(Effect.provide(out.layer));
  });

  it.live("includes multipart input guidance and examples in schema output", () => {
    const out = mockOutput({ format: "json" });

    return Effect.gen(function* () {
      yield* showPlatformSchema(methodNameFor("v1DeployAFunction"));

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "",
          data: expect.objectContaining({
            method: "projects.functions.deploy",
            inputHelp: expect.objectContaining({
              body: expect.objectContaining({
                summary:
                  "This request body expects structured fields via `--json` and binary fields via `--upload`.",
                notes: expect.arrayContaining([
                  "Use repeated `--upload field=path` flags for binary multipart fields, including array-valued fields.",
                ]),
                examples: expect.arrayContaining([
                  expect.objectContaining({
                    command: expect.stringContaining("--upload file=./file-1.bin"),
                  }),
                ]),
              }),
            }),
          }),
        }),
      );
    }).pipe(Effect.provide(out.layer));
  });

  it.live("includes urlencoded input guidance and examples in schema output", () => {
    const out = mockOutput({ format: "json" });

    return Effect.gen(function* () {
      yield* showPlatformSchema(methodNameFor("v1ExchangeOauthToken"));

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "",
          data: expect.objectContaining({
            method: "oauth.token.exchange",
            inputHelp: expect.objectContaining({
              body: expect.objectContaining({
                summary: "This request body expects structured fields passed to `--json`.",
                examples: expect.arrayContaining([
                  expect.objectContaining({
                    command: expect.stringContaining("--json"),
                  }),
                ]),
              }),
            }),
          }),
        }),
      );
    }).pipe(Effect.provide(out.layer));
  });

  it.live("shows string-only union params as plain strings", () => {
    const out = mockOutput({ format: "json" });

    return Effect.gen(function* () {
      yield* showPlatformSchema("branches.delete");

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "",
          data: expect.objectContaining({
            method: "branches.delete",
            examples: expect.arrayContaining([
              expect.objectContaining({
                command: expect.stringContaining('--params \'{"branch_id_or_ref":"branch-ref"}\''),
              }),
            ]),
            request: expect.objectContaining({
              params: expect.arrayContaining([
                expect.objectContaining({
                  name: "branch_id_or_ref",
                  kind: "string",
                }),
              ]),
            }),
          }),
        }),
      );
    }).pipe(Effect.provide(out.layer));
  });

  it.live("fails on an unknown platform method", () => {
    const out = mockOutput({ format: "json" });

    return Effect.gen(function* () {
      const exit = yield* showPlatformSchema("projects.missing").pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(getFailError(exit)).toBeInstanceOf(PlatformMethodNotFoundError);
    }).pipe(Effect.provide(out.layer));
  });

  it.live("renders generated examples in text mode", () => {
    const out = mockOutput({ format: "text" });

    return Effect.gen(function* () {
      yield* showPlatformSchema(methodNameFor("v1CreateAFunction"));

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: expect.stringContaining(
            'cat ./body.bin | supabase platform projects functions create --params \'{"ref":"project-ref"}\' --body -',
          ),
        }),
      );
    }).pipe(Effect.provide(out.layer));
  });

  it.live("includes no-input examples for routes without request input", () => {
    const out = mockOutput({ format: "json" });

    return Effect.gen(function* () {
      yield* showPlatformSchema(methodNameFor("v1ListAllProjects"));

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "",
          data: expect.objectContaining({
            method: "projects.list",
            examples: expect.arrayContaining([
              expect.objectContaining({
                command: "supabase platform projects list",
              }),
            ]),
          }),
        }),
      );
    }).pipe(Effect.provide(out.layer));
  });
});
