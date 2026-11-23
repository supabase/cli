import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Layer } from "effect";

import { program } from "../src/examples/counters/main.ts";
import { Terminal, Theme, Tui } from "../src/index.ts";
import { supabaseTheme } from "../src/supabase/theme.ts";

const main = Effect.fn("examples.counters")(function* () {
  const counts = yield* Tui.run(program);
  yield* Console.log(`final counts: ${counts.join(", ")}`);
});

main().pipe(
  Effect.provide(Layer.mergeAll(Terminal.layerProcess(), Theme.layer(supabaseTheme))),
  NodeRuntime.runMain,
);
