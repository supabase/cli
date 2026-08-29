import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Redacted } from "effect";
import {
  FunctionSettingsDefaults,
  type FunctionSettings,
} from "../model/capabilities/functions.ts";
import { FunctionNotFoundError, FunctionPathError, makeFunctionsRoot } from "./FunctionsRoot.ts";
import { discoverFunction } from "./FunctionDiscovery.ts";

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const write = (path: string, content: string) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.writeFileString(path, content)));

const settings = (override: Partial<FunctionSettings> = {}): FunctionSettings => ({
  ...FunctionSettingsDefaults,
  ...override,
});

const capture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.map((value) => ({ tag: "success" as const, value })),
    Effect.catch((error: E) => Effect.succeed({ tag: "failure" as const, error })),
  );

describe("live Functions discovery", () => {
  it.live("discovers a function entrypoint on every request", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-functions-" });
        const functionRoot = `${root}/functions`;
        yield* fs.makeDirectory(`${functionRoot}/rest`, { recursive: true });
        yield* write(`${functionRoot}/rest/index.ts`, "export default () => new Response('one')");
        const functionsRoot = yield* makeFunctionsRoot({ root: functionRoot });
        const invocation = yield* discoverFunction(functionsRoot, "rest", {
          rest: FunctionSettingsDefaults,
        });
        expect(invocation.slug).toBe("rest");
        expect(invocation.entrypoint.native).toBe(
          yield* fs.realPath(`${functionRoot}/rest/index.ts`),
        );
        expect(invocation.root.mount.readOnly).toBe(true);
      }),
    ),
  );

  it.live(
    "observes live edits, custom metadata, shared modules, and stable container mapping",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-functions-live-" });
          const functionRoot = `${root}/functions`;
          yield* fs.makeDirectory(`${functionRoot}/rest/public`, { recursive: true });
          yield* fs.makeDirectory(`${functionRoot}/config-only`, { recursive: true });
          yield* fs.makeDirectory(`${functionRoot}/_shared`, { recursive: true });
          yield* write(
            `${functionRoot}/config-only/main.ts`,
            "export default () => new Response('config')",
          );
          yield* write(
            `${functionRoot}/rest/custom.ts`,
            "export default () => new Response('custom')",
          );
          yield* write(`${functionRoot}/rest/index.ts`, "export default () => new Response('one')");
          yield* write(`${functionRoot}/rest/public/logo.txt`, "logo");
          yield* write(`${functionRoot}/_shared/shared.ts`, "export const shared = true");
          yield* write(
            `${functionRoot}/rest/deno.json`,
            '{"imports":{"shared":"../_shared/shared.ts"}}',
          );
          const functionsRoot = yield* makeFunctionsRoot({ root: functionRoot });
          const entryFile = yield* functionsRoot.resolveFunctionPath("rest", "index.ts", {
            kind: "file",
          });
          const sharedFile = yield* functionsRoot.resolveModulePath(
            entryFile,
            "../_shared/shared.ts",
          );
          expect(sharedFile.native).toBe(yield* fs.realPath(`${functionRoot}/_shared/shared.ts`));
          const secret = Redacted.make("never-in-an-error");
          const first = yield* discoverFunction(functionsRoot, "rest", {
            rest: settings({
              entrypoint: "custom.ts",
              static_files: ["public/*.txt"],
              env: { API_KEY: secret },
            }),
          });
          expect(yield* fs.readFileString(first.entrypoint.native)).toContain("custom");
          expect(first.entrypoint.native).toBe(
            yield* fs.realPath(`${functionRoot}/rest/custom.ts`),
          );
          expect(first.importMap?.native).toBe(
            yield* fs.realPath(`${functionRoot}/rest/deno.json`),
          );
          expect(first.staticPatterns[0]?.container).toBe(
            "/__supabase_functions/rest/public/*.txt",
          );
          expect(first.root.mount).toEqual({
            source: yield* fs.realPath(functionRoot),
            target: "/__supabase_functions",
            readOnly: true,
          });
          expect(Redacted.isRedacted(first.env.API_KEY)).toBe(true);

          const configOnly = yield* discoverFunction(functionsRoot, "config-only", {
            "config-only": settings({ entrypoint: "main.ts" }),
          });
          expect(configOnly.entrypoint.native).toBe(
            yield* fs.realPath(`${functionRoot}/config-only/main.ts`),
          );

          yield* write(
            `${functionRoot}/rest/custom.ts`,
            "export default () => new Response('edited')",
          );
          const edited = yield* discoverFunction(functionsRoot, "rest", {
            rest: settings({ entrypoint: "custom.ts" }),
          });
          expect(edited.entrypoint.native).toBe(first.entrypoint.native);
          expect(yield* fs.readFileString(edited.entrypoint.native)).toContain("edited");
          yield* fs.remove(`${functionRoot}/rest/custom.ts`);
          const deletedEffect = discoverFunction(functionsRoot, "rest", {
            rest: settings({ entrypoint: "custom.ts" }),
          });
          const deleted = yield* capture(deletedEffect);
          expect(deleted.tag).toBe("failure");
          if (deleted.tag === "failure")
            expect(deleted.error).toBeInstanceOf(FunctionNotFoundError);
        }),
      ),
  );

  it.live("fails closed for disabled, invalid, and escaping function paths", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-functions-paths-" });
        const functionRoot = `${root}/functions`;
        const outside = `${root}/outside.ts`;
        yield* fs.makeDirectory(`${functionRoot}/rest`, { recursive: true });
        yield* write(`${functionRoot}/rest/index.ts`, "export default 1");
        yield* write(outside, "export default 0");
        yield* fs.symlink(outside, `${functionRoot}/rest/escape.ts`);
        const functionsRoot = yield* makeFunctionsRoot({ root: functionRoot });
        const escaped = discoverFunction(functionsRoot, "rest", {
          rest: settings({ entrypoint: "escape.ts" }),
        });
        const escapedResult = yield* capture(escaped);
        expect(escapedResult.tag).toBe("failure");
        if (escapedResult.tag === "failure")
          expect(escapedResult.error).toBeInstanceOf(FunctionPathError);

        const traversal = discoverFunction(functionsRoot, "rest", {
          rest: settings({ entrypoint: "../outside.ts" }),
        });
        const traversalResult = yield* capture(traversal);
        expect(traversalResult.tag).toBe("failure");
        if (traversalResult.tag === "failure")
          expect(traversalResult.error).toBeInstanceOf(FunctionPathError);

        const disabled = discoverFunction(functionsRoot, "rest", {
          rest: settings({ enabled: false }),
        });
        const disabledResult = yield* capture(disabled);
        expect(disabledResult.tag).toBe("failure");
        if (disabledResult.tag === "failure")
          expect(disabledResult.error).toBeInstanceOf(FunctionNotFoundError);

        const invalid = discoverFunction(functionsRoot, "not.valid", {
          rest: settings(),
        });
        const invalidResult = yield* capture(invalid);
        expect(invalidResult.tag).toBe("failure");
        if (invalidResult.tag === "failure")
          expect(invalidResult.error).toBeInstanceOf(FunctionNotFoundError);
      }),
    ),
  );

  it.live("rejects traversal and absolute values for every configured path class", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-functions-config-" });
        const functionRoot = `${root}/functions`;
        yield* fs.makeDirectory(`${functionRoot}/rest/public`, { recursive: true });
        yield* write(`${functionRoot}/rest/index.ts`, "export default 1");
        const functionsRoot = yield* makeFunctionsRoot({ root: functionRoot });
        const cases: ReadonlyArray<readonly [string, Partial<FunctionSettings>]> = [
          ["entrypoint traversal", { entrypoint: "../outside.ts" }],
          ["entrypoint absolute", { entrypoint: `${root}/outside.ts` }],
          ["import map traversal", { import_map: "../deno.json" }],
          ["import map absolute", { import_map: `${root}/deno.json` }],
          ["static traversal", { static_files: ["../outside.txt"] }],
          ["static absolute", { static_files: [`${root}/outside.txt`] }],
        ];
        for (const [name, override] of cases) {
          const result = yield* capture(
            discoverFunction(functionsRoot, "rest", { rest: settings(override) }),
          );
          expect(result.tag, name).toBe("failure");
          if (result.tag === "failure") expect(result.error).toBeInstanceOf(FunctionPathError);
        }
      }),
    ),
  );

  it.live(
    "observes a function created after an initial miss and canonicalizes a symlinked root",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-functions-root-" });
          const canonical = `${root}/canonical`;
          const configured = `${root}/configured`;
          yield* fs.makeDirectory(`${canonical}/rest`, { recursive: true });
          yield* fs.symlink(canonical, configured);
          const functionsRoot = yield* makeFunctionsRoot({ root: configured });
          const missing = yield* capture(
            discoverFunction(functionsRoot, "rest", { rest: settings() }),
          );
          expect(missing.tag).toBe("failure");
          if (missing.tag === "failure")
            expect(missing.error).toBeInstanceOf(FunctionNotFoundError);
          yield* write(`${canonical}/rest/index.ts`, "export default 1");
          const found = yield* discoverFunction(functionsRoot, "rest", { rest: settings() });
          expect(found.root.native).toBe(yield* fs.realPath(canonical));
          expect(found.root.mount.source).toBe(found.root.native);

          yield* fs.makeDirectory(`${canonical}/new`, { recursive: true });
          yield* write(`${canonical}/new/index.ts`, "export default 2");
          const created = yield* discoverFunction(functionsRoot, "new", {});
          expect(created.slug).toBe("new");
        }),
      ),
  );

  it.live("rejects symlink escapes from the function directory and shared root", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-functions-symlink-" });
        const functionRoot = `${root}/functions`;
        const outside = `${root}/outside`;
        yield* fs.makeDirectory(`${functionRoot}/rest`, { recursive: true });
        yield* fs.makeDirectory(`${outside}/rest`, { recursive: true });
        yield* write(`${outside}/rest/index.ts`, "export default 0");
        yield* fs.symlink(`${outside}/rest`, `${functionRoot}/linked`);
        const functionsRoot = yield* makeFunctionsRoot({ root: functionRoot });
        const linked = yield* capture(
          discoverFunction(functionsRoot, "linked", { linked: settings() }),
        );
        expect(linked.tag).toBe("failure");
        if (linked.tag === "failure") expect(linked.error).toBeInstanceOf(FunctionPathError);

        yield* fs.remove(`${functionRoot}/linked`);
        yield* write(`${outside}/shared.ts`, "export const outside = true");
        yield* fs.symlink(outside, `${functionRoot}/_shared`);
        yield* write(`${functionRoot}/rest/index.ts`, "export default 1");
        const shared = yield* capture(
          discoverFunction(functionsRoot, "rest", { rest: settings() }),
        );
        expect(shared.tag).toBe("failure");
        if (shared.tag === "failure") expect(shared.error).toBeInstanceOf(FunctionPathError);
      }),
    ),
  );
});
