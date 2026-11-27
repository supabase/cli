import { BunRuntime } from "@effect/platform-bun";
import { Command, UiSchema } from "@effect/ui";
import {
  Terminal,
  TerminalCommand,
  TerminalHost,
  TerminalSubscription,
  TerminalTheme,
} from "@supabase/ui-terminal";
import { Console, Effect, Layer, Schema } from "effect";

import { KeyValue, Spinner } from "./blocks.ts";
import { select } from "./prompt.ts";
import { supabaseTheme } from "./theme.ts";

const GalleryProps = Schema.Struct({ unicode: Schema.Boolean });

const GalleryModel = Schema.Struct({ databaseReady: Schema.Boolean, done: Schema.Boolean });

const GalleryMessage = UiSchema.TaggedEnum({ DatabaseReady: {}, PressedEnter: {} });

const WaitForDatabase = Command.make("tui/WaitForDatabase", { args: {} }, () =>
  Effect.sleep("3200 millis").pipe(Effect.as(GalleryMessage.DatabaseReady())),
);

const Gallery = Terminal.component({
  name: "Gallery",
  props: GalleryProps,
  model: GalleryModel,
  message: GalleryMessage,
}).make({
  init: ($) => $.set({ databaseReady: false, done: false }).run(WaitForDatabase.make({})),
  update: {
    DatabaseReady: ($) => $.evolve({ databaseReady: true }),
    PressedEnter: ($) => $.evolve({ done: true }).run(TerminalCommand.finish()),
  },
  subscriptions: () => [
    TerminalSubscription.shortcuts([{ key: "return", message: GalleryMessage.PressedEnter() }]),
  ],
  view: (h, model) => {
    const { unicode } = h.props;
    return h.box.style({ flexDirection: "column" }).children(
      h.static.children(
        h.text.style({ bold: true }).children("Supabase TUI gallery"),
        Spinner(h, {
          key: "linked",
          props: { label: "Linked project", status: "succeeded", unicode },
        }),
        Spinner(h, {
          key: "failed",
          props: { label: "Migration failed", status: "failed", unicode },
        }),
        Spinner(h, {
          key: "pending",
          props: { label: "Pending changes", status: "warning", unicode },
        }),
        h.box.style({ border: "rounded", borderTone: "muted", paddingX: 1 }).children(
          KeyValue(h, {
            unicode,
            tone: "accent",
            entries: [
              { key: "API URL", value: "http://127.0.0.1:54321" },
              { key: "Studio URL", value: "http://127.0.0.1:54323" },
              { key: "DB URL", value: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" },
            ],
          }),
        ),
      ),
      model.done
        ? null
        : h.box.style({ flexDirection: "column" }).children(
            Spinner(h, { key: "images", props: { label: "Pulling images", unicode } }),
            Spinner(h, {
              key: "database",
              props: {
                label: model.databaseReady ? "Database ready" : "Waiting for database",
                status: model.databaseReady ? "succeeded" : "running",
                unicode,
              },
            }),
            h.text.style({ tone: "muted" }).children("press enter to continue"),
          ),
    );
  },
});

const gallery = Effect.gen(function* () {
  const terminal = yield* TerminalHost.Transport;
  yield* TerminalHost.run(Gallery, { unicode: terminal.capabilities.unicode });
  const region = yield* select({
    message: "Which region?",
    options: [
      { value: "us-east-1", label: "East US (N. Virginia)", hint: "closest" },
      { value: "eu-west-1", label: "West EU (Ireland)" },
      { value: "ap-southeast-1", label: "Southeast Asia (Singapore)" },
    ],
  });
  yield* Console.log(`region: ${region}`);
});

BunRuntime.runMain(
  gallery.pipe(
    Effect.provide(Layer.merge(TerminalHost.layerProcess, TerminalTheme.layer(supabaseTheme))),
  ),
);
