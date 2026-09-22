import path from "node:path";
import type { BunPlugin } from "bun";

const oxfmtStub = path.join(import.meta.dir, "oxfmt-stub.ts");

/**
 * `Bun.build` `alias` does not rewrite imports inside dependencies.
 * `@supabase/postgrest-typegen` imports `oxfmt`, which the CLI never calls.
 */
export const oxfmtStubPlugin: BunPlugin = {
  name: "oxfmt-stub",
  setup(build) {
    build.onResolve({ filter: /^oxfmt$/ }, () => ({ path: oxfmtStub }));
  },
};
