import { Option, Schema } from "effect";

import * as KeyValue from "../../blocks/key-value.ts";
import * as Select from "../../blocks/select.ts";
import * as Spinner from "../../blocks/spinner.ts";
import { makeProgram } from "../../runtime/public.ts";
import { Key } from "../../terminal/public.ts";
import { column, screen, text } from "../../view/public.ts";
import type { Node, Tone } from "../../view/public.ts";

const tones: ReadonlyArray<Tone> = [
  "default",
  "muted",
  "accent",
  "success",
  "warning",
  "danger",
  "info",
];

const regions = [
  { value: "us-east-1", label: "East US (N. Virginia)", hint: "closest" },
  { value: "eu-west-1", label: "West EU (Ireland)" },
  { value: "ap-southeast-1", label: "Southeast Asia (Singapore)" },
];

const section = (label: string, ...children: ReadonlyArray<Node>): Node =>
  column([text(label, { emphasis: "bold" }), ...children, text("")]);

const activeSelect = Select.init(regions, "eu-west-1");

const submittedSelect = Select.informKeyPressed(activeSelect, Key.Enter({})).model;

/** One screen with every starter block in its main states. */
const gallery = (): Node =>
  column([
    section(
      "Spinner, stopped",
      Spinner.view(Spinner.init, { label: "Migrations applied", status: "succeeded" }),
      Spinner.view(Spinner.init, { label: "Functions failed to deploy", status: "failed" }),
      Spinner.view(Spinner.init, { label: "Storage needs attention", status: "warning" }),
    ),
    section(
      "Spinner, running",
      ...tones.map((tone) => Spinner.view(Spinner.init, { label: tone, tone })),
    ),
    section("Select, active", Select.view(activeSelect, { message: "Which region?", rows: 8 })),
    section(
      "Select, submitted",
      Select.view(submittedSelect, { message: "Which region?", rows: 8 }),
    ),
    section(
      "KeyValue",
      column(
        [
          KeyValue.view({
            entries: [
              { key: "Project", value: "my-app" },
              { key: "Region", value: "eu-west-1" },
            ],
          }),
          KeyValue.view({
            tone: "success",
            entries: [
              { key: "API URL", value: "http://127.0.0.1:54321" },
              { key: "Studio URL", value: "http://127.0.0.1:54323" },
            ],
          }),
        ],
        { border: "rounded", padding: { x: 1 }, width: "100%", maxWidth: 80 },
      ),
    ),
  ]);

/** Renders the gallery once and finishes, so it lands in scrollback. */
export const staticProgram = makeProgram({
  Model: Schema.Undefined,
  init: () => ({ model: undefined }),
  update: (model) => ({ model }),
  view: () => screen(gallery()),
  result: () => Option.some(undefined),
});
