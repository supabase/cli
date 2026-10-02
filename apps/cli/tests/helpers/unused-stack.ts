import { Effect, Layer, Stream } from "effect";
import type { Stack } from "@supabase/stack/effect";
import { StackApi } from "../../src/command-internal/stack-api.ts";
import { StackCatalogSetup } from "../../src/command-internal/stack-catalog-setup.ts";

const unused = () => Effect.die("Stack services must not run in this legacy-backend scenario");

export const unusedStackServices = Layer.mergeAll(
  Layer.succeed(StackApi, {
    create: unused,
    open: unused,
    discover: unused,
    find: unused,
  }),
  Layer.succeed(StackCatalogSetup, { apply: unused }),
);

/** Fills a fake `Stack`'s gateway log stream for tests that never read it. */
export const unusedGateway: Stack["gateway"] = { readLogs: () => Stream.die("unused") };
