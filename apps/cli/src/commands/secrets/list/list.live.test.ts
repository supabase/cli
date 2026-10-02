import { randomUUID } from "node:crypto";

import { V1ListAllSecretsOutput } from "@supabase/api/effect";
import { Cause, Effect, Exit, Schema } from "effect";
import { expect } from "vitest";

import { test, throwWithCleanup } from "../../../../tests/helpers/live.ts";
import { requireSuccess, unsetSecret } from "../../../../tests/helpers/secrets-live.ts";

// The json payload decodes straight back through the generated list schema.
const secretsPayload = Schema.decodeEffect(Schema.fromJsonString(V1ListAllSecretsOutput));

// Not wired to the test `signal`: an interrupt SIGKILLs an in-flight cleanup
// mid-request (the run's scope release kills the process group), so letting the
// bounded cleanup run out is strictly safer.
test("lists a secret created on the remote project", ({ cliEffect, project }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const name = `CLI_E2E_LIST_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;

      const target = Effect.gen(function* () {
        const created = yield* cliEffect([
          "secrets",
          "set",
          `${name}=live-value`,
          "--project-ref",
          project.ref,
        ]);
        yield* requireSuccess(created, "secrets set setup");

        const result = yield* cliEffect([
          "secrets",
          "list",
          "--output",
          "json",
          "--project-ref",
          project.ref,
        ]);
        expect(result.exitCode, result.stderr).toBe(0);
        const secrets = yield* secretsPayload(result.stdout);
        expect(secrets.map((secret) => secret.name)).toContain(name);
      });

      // The cleanup runs whatever the target did; neither failure hides the other.
      const targetExit = yield* Effect.exit(target);
      const cleanupExit = yield* Effect.exit(unsetSecret(cliEffect, name, project.ref));
      return {
        targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
        cleanupErrors: Exit.isFailure(cleanupExit) ? [Cause.squash(cleanupExit.cause)] : [],
      };
    }),
  ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)));
