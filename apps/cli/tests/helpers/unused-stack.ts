import { Effect, Layer } from "effect";
import { StackApi } from "../../src/command-internal/stack-api.ts";
import { StackCatalogSetup } from "../../src/command-internal/stack-catalog-setup.ts";

const unused = () => Effect.die("Stack services must not run in this legacy-backend scenario");

export const unusedStackServices = Layer.mergeAll(
  Layer.succeed(StackApi, {
    create: unused,
    open: unused,
    discover: unused,
    resolveIdentity: unused,
  }),
  Layer.succeed(StackCatalogSetup, { apply: unused }),
);
