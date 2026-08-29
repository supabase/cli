import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { update } from "./update.handler.ts";
import {
  emptyEnv,
  mockOutput,
  mockProjectLinkRemote,
  mockProjectLinkState,
} from "../../../../tests/helpers/mocks.ts";

describe("update handler", () => {
  it.live("reports stack configuration readiness without a linked project", () => {
    const out = mockOutput({ interactive: false });
    return update({ stack: "default" }).pipe(
      Effect.provide(
        Layer.mergeAll(emptyEnv(), out.layer, mockProjectLinkState(), mockProjectLinkRemote()),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(out.messages).toContainEqual(
            expect.objectContaining({
              type: "success",
              message: "No linked project metadata to refresh.",
            }),
          );
          expect(
            out.messages.some((message) => message.message.includes("Stack configuration")),
          ).toBe(false);
          expect(out.messages.some((message) => message.message.includes("stack is ready"))).toBe(
            false,
          );
        }),
      ),
      Effect.exit,
      Effect.tap((exit) => Effect.sync(() => expect(Exit.isSuccess(exit)).toBe(true))),
    );
  });

  it.live("reports only refreshed metadata for a linked project", () => {
    const out = mockOutput({ interactive: false });
    return update({ stack: "default" }).pipe(
      Effect.provide(
        Layer.mergeAll(
          emptyEnv(),
          out.layer,
          mockProjectLinkState({
            project: {
              ref: "project-ref",
              name: "Demo",
              organization_id: "org-id",
              organization_slug: "org",
            },
            active_branch: { ref: "project-ref", name: "main", is_default: true },
            fetchedAt: "2026-08-29T00:00:00.000Z",
            versions: { postgres: "15", postgrest: "v1", auth: "v1", storage: "v1" },
          }),
          mockProjectLinkRemote({
            linkedProject: {
              ref: "project-ref",
              name: "Demo",
              region: "eu",
              status: "ACTIVE_HEALTHY",
              versions: { postgres: "15", postgrest: "v1", auth: "v1", storage: "v1" },
            },
          }),
        ),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(out.messages).toContainEqual(
            expect.objectContaining({
              type: "success",
              message: "Linked project metadata refreshed.",
            }),
          );
          expect(
            out.messages.some((message) => message.message.includes("Stack configuration")),
          ).toBe(false);
          expect(out.messages.some((message) => message.message.includes("stack is ready"))).toBe(
            false,
          );
        }),
      ),
      Effect.exit,
      Effect.tap((exit) => Effect.sync(() => expect(Exit.isSuccess(exit)).toBe(true))),
    );
  });
});
