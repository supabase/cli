import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Layer } from "effect";

import { program } from "../src/examples/counter/main.ts";
import { Terminal, Theme, Tui } from "../src/index.ts";
import { supabaseTheme } from "../src/supabase/theme.ts";

const main = Effect.fn("examples.counter")(function* () {
  const count = yield* Tui.run(program);
  yield* Console.log(`final count: ${count}`);
});

main().pipe(
  Effect.provide(Layer.mergeAll(Terminal.layerProcess(), Theme.layer(supabaseTheme))),
  NodeRuntime.runMain,
);
