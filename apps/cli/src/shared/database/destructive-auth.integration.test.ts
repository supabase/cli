import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { authorizeMutation } from "./destructive-auth.ts";
import type { DatabaseTarget } from "./database-target.ts";

const local: DatabaseTarget = {
  kind: "local",
  identity: "local:default",
  connectionString: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  disposable: true,
  durable: false,
  connectionVerified: true,
};

const linked: DatabaseTarget = {
  kind: "linked",
  identity: "abcdefghijklmnop",
  connectionString: "postgresql://postgres:secret@db.example/postgres",
  disposable: false,
  durable: true,
  connectionVerified: true,
  projectRef: "abcdefghijklmnop",
};

const unverifiedLinked: DatabaseTarget = {
  kind: "linked",
  identity: "abcdefghijklmnop",
  connectionString: "postgresql://postgres:secret@db.example/postgres",
  disposable: false,
  durable: true,
  connectionVerified: false,
  projectRef: "abcdefghijklmnop",
};

const url: DatabaseTarget = {
  kind: "url",
  identity: "connection-string",
  connectionString: "postgresql://postgres:secret@db.example/postgres",
  disposable: false,
  durable: true,
  connectionVerified: false,
};

describe("authorizeMutation", () => {
  it.live("auto-approves disposable local targets", () => {
    const out = mockOutput({ interactive: false });
    return Effect.gen(function* () {
      yield* authorizeMutation({
        target: local,
        flags: { yes: false, allowRemote: false },
        command: "schema apply",
      });
    }).pipe(Effect.provide(out.layer));
  });

  it.live("rejects mismatched --project-ref", () => {
    const out = mockOutput({ interactive: false });
    return Effect.gen(function* () {
      const exit = yield* authorizeMutation({
        target: linked,
        flags: { yes: true, allowRemote: false, projectRef: "otherref" },
        command: "migrations push",
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(out.layer));
  });

  it.live("accepts a matching --project-ref for linked targets", () => {
    const out = mockOutput({ interactive: false });
    return Effect.gen(function* () {
      yield* authorizeMutation({
        target: unverifiedLinked,
        flags: { yes: true, allowRemote: false, projectRef: "abcdefghijklmnop" },
        command: "migrations push",
      });
    }).pipe(Effect.provide(out.layer));
  });

  it.live("accepts --yes for non-interactive linked pushes", () => {
    const out = mockOutput({ interactive: false });
    return Effect.gen(function* () {
      yield* authorizeMutation({
        target: unverifiedLinked,
        flags: { yes: true, allowRemote: false },
        command: "migrations push",
      });
    }).pipe(Effect.provide(out.layer));
  });

  it.live("requires --yes or --project-ref for non-interactive linked pushes", () => {
    const out = mockOutput({ interactive: false });
    return Effect.gen(function* () {
      const exit = yield* authorizeMutation({
        target: unverifiedLinked,
        flags: { yes: false, allowRemote: false },
        command: "migrations push",
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(out.layer));
  });

  it.live("requires --allow-remote for URL targets", () => {
    const out = mockOutput({ interactive: false });
    return Effect.gen(function* () {
      const exit = yield* authorizeMutation({
        target: url,
        flags: { yes: true, allowRemote: false },
        command: "migrations push",
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(Layer.mergeAll(out.layer)));
  });
});
