import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem, Schema } from "effect";

import {
  makeTempHome,
  runSupabaseEffect,
  spawnSupabase,
  stripAnsi,
} from "../../../../tests/helpers/cli.ts";

const parent = "abcdefghijklmnopqrst";
const target = {
  kind: "linked",
  project_ref: parent,
  environment: "production",
  project_name: "Parent",
};
const branch = "11111111-1111-4111-8111-111111111111";
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decode = (text: string) => decodeJson(text);

it.live(
  "preserves delete output framing, exit codes, consent and the parent cache through the binary",
  () =>
    Effect.gen(function* () {
      const home = yield* makeTempHome;
      const fs = yield* FileSystem.FileSystem;
      let exists = true;
      let status = 200;
      let holdDelete = false;
      const deleteStarted = yield* Deferred.make<void>();
      const releaseDelete = Promise.withResolvers<Response>();
      const requests: string[] = [];
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
              const path = new URL(request.url).pathname;
              requests.push(`${request.method} ${path}`);
              if (path === `/v1/projects/${parent}`) {
                return Response.json({
                  id: parent,
                  ref: parent,
                  name: "Parent",
                  organization_id: "org-1",
                  organization_slug: "acme",
                  region: "us-east-1",
                  created_at: "2026-01-01T00:00:00Z",
                  status: "ACTIVE_HEALTHY",
                  database: {
                    host: "db.example.invalid",
                    version: "15",
                    postgres_engine: "15",
                    release_channel: "ga",
                  },
                });
              }
              if (path === `/v1/branches/${branch}` && exists) {
                if (request.method === "DELETE") {
                  if (holdDelete) {
                    Deferred.doneUnsafe(deleteStarted, Effect.void);
                    return releaseDelete.promise;
                  }
                  if (status === 200) exists = false;
                  return Response.json(status === 200 ? { message: "ok" } : {}, { status });
                }
                return Response.json({
                  ref: branch,
                  postgres_version: "15",
                  postgres_engine: "15",
                  release_channel: "ga",
                  status: "ACTIVE_HEALTHY",
                  db_host: "h",
                  db_port: 5432,
                });
              }
              return new Response(null, { status: 404 });
            },
          }),
        ),
        (running) => Effect.promise(() => running.stop(true)),
      );
      const profile = `${home.dir}/profile.yaml`;
      yield* fs.writeFileString(
        profile,
        `name: delete-e2e\napi_url: ${server.url.origin}\ndashboard_url: ${server.url.origin}\nproject_host: example.invalid\n`,
      );
      const argv = (format: string, ...args: string[]) => [
        "branches",
        "delete",
        branch,
        "--project-ref",
        parent,
        "--output-format",
        format,
        ...args,
      ];
      const options = {
        cwd: home.dir,
        home: home.dir,
        stdin: "yes\n",
        env: {
          SUPABASE_ACCESS_TOKEN: `sbp_${"a".repeat(40)}`,
          SUPABASE_PROFILE: profile,
          SUPABASE_YES: "",
          DO_NOT_TRACK: "1",
          NO_COLOR: "1",
        },
      };
      const run = (format: string, ...args: string[]) =>
        runSupabaseEffect(argv(format, ...args), options);

      for (const format of ["text", "json", "stream-json"]) {
        exists = true;
        status = 200;
        requests.length = 0;
        const result = yield* run(format, "--yes");
        expect(result.exitCode, result.stderr + result.stdout).toBe(0);
        expect(exists).toBe(false);
        expect(requests.slice(0, 2)).toEqual([
          `GET /v1/branches/${branch}`,
          `DELETE /v1/branches/${branch}`,
        ]);
        if (format === "text") expect(requests.slice(2)).toEqual([`GET /v1/projects/${parent}`]);
        if (format === "text") {
          const progress = stripAnsi(result.stdout)
            .replace(/^[│|◇o][ \t]*/gm, "")
            .trim();
          expect(["", "Deleting branch..."]).toContain(progress);
          expect(stripAnsi(result.stderr)).toContain(`Deleted preview branch: ${branch}\n`);
        } else {
          const data = { project_ref: branch, message: "Deleted preview branch", target };
          if (format === "json") expect(decode(result.stdout)).toEqual(data);
          else
            expect(result.stdout.trimEnd().split("\n").map(decode)).toEqual([
              { type: "result", data, timestamp: expect.any(String) },
            ]);
          expect(result.stderr).not.toContain("Deleting branch");
        }

        exists = true;
        status = 500;
        const failure = yield* run(format, "--yes");
        expect(failure.exitCode).toBe(1);
        expect(exists).toBe(true);
        if (format === "text") {
          expect(stripAnsi(failure.stderr)).toContain("unexpected delete branch status 500");
        } else {
          const error = {
            code: "BranchesDeleteUnexpectedStatusError",
            message: "unexpected delete branch status 500: {}",
          };
          expect(failure.stderr).not.toContain("Deleting branch");
          expect(failure.stdout.trimEnd().split("\n").map(decode)).toEqual([
            format === "json"
              ? { target, _tag: "Error", error }
              : { target, type: "error", error, timestamp: expect.any(String) },
          ]);
        }
      }

      requests.length = 0;
      const refused = yield* run("json");
      expect(refused.exitCode).toBe(1);
      expect(decode(refused.stdout)).toMatchObject({
        _tag: "Error",
        error: { code: "HostedMutationConsentRequiredError" },
      });
      expect(exists).toBe(true);

      expect(requests).toEqual([`GET /v1/branches/${branch}`]);

      const invalid = yield* run("json", "--not-a-delete-option");
      expect(invalid.exitCode).toBe(1);
      expect(decode(invalid.stdout)).toMatchObject({ _tag: "Error" });
      expect(requests).toEqual([`GET /v1/branches/${branch}`]);

      const help = yield* run("text", "--help");
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain("Delete a preview branch");
      expect(requests).toEqual([`GET /v1/branches/${branch}`]);

      const cache = `${home.dir}/supabase/.temp/linked-project.json`;
      expect(decode(yield* fs.readFileString(cache))).toMatchObject({ ref: parent });
      yield* fs.remove(cache);
      holdDelete = true;
      requests.length = 0;
      yield* Effect.gen(function* () {
        const child = yield* spawnSupabase(argv("stream-json", "--yes"), options);
        yield* Deferred.await(deleteStarted).pipe(Effect.timeout("10 seconds"));
        yield* child.kill("SIGINT");
        const interrupted = yield* child.waitForExit();
        expect(interrupted.exitCode, interrupted.stderr).toBe(130);
        expect(interrupted.stdout).toBe("");
        expect(exists).toBe(true);
        expect(requests).toEqual([
          `GET /v1/branches/${branch}`,
          `DELETE /v1/branches/${branch}`,
          `GET /v1/projects/${parent}`,
        ]);
        expect(decode(yield* fs.readFileString(cache))).toMatchObject({ ref: parent });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => releaseDelete.resolve(new Response(null, { status: 503 }))),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
