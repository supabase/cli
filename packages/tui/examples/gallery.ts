import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Layer } from "effect";

import { program } from "../src/examples/gallery/main.ts";
import { staticProgram } from "../src/examples/gallery/static.ts";
import { Prompt, Terminal, Theme, Tui } from "../src/index.ts";
import { supabaseTheme } from "../src/supabase/theme.ts";

const main = Effect.fn("examples.gallery")(function* () {
  yield* Tui.run(staticProgram);
  const terminal = yield* Terminal.Service;
  if (!terminal.capabilities.interactive) return;

  yield* Tui.run(program);
  const region = yield* Prompt.select({
    message: "Which region?",
    options: [
      { value: "us-east-1", label: "East US (N. Virginia)" },
      { value: "eu-west-1", label: "West EU (Ireland)" },
      { value: "ap-southeast-1", label: "Southeast Asia (Singapore)" },
    ],
  });
  yield* Console.log(`region: ${region}`);
});

main().pipe(
  Effect.provide(Layer.mergeAll(Terminal.layerProcess(), Theme.layer(supabaseTheme))),
  NodeRuntime.runMain,
);
