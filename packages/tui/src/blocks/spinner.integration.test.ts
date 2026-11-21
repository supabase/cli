import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Option, Queue, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import * as Subscription from "foldkit/subscription";
import * as Update from "foldkit/update";

import { makeProgram, run } from "../runtime/public.ts";
import {
  dropTrailingBlank,
  nextFrame,
  shown,
  withTerminal,
  Written,
} from "../runtime/test-support.ts";
import { TestTerminal } from "../terminal/testing.ts";
import { screen } from "../view/public.ts";
import * as Spinner from "./spinner.ts";
import { render } from "./test-support.ts";

const Gate = defineTaggedUnion({ Active: {}, Paused: {} });

const Lifecycle = defineTaggedUnion({ Running: {}, Finished: {} });

const Model = Schema.Struct({
  spinner: Spinner.Model,
  gate: Gate,
  lifecycle: Lifecycle,
});
type Model = typeof Model.Type;

const Message = defineMessageUnion({
  GotSpinnerMessage: { message: Spinner.Message },
  Paused: {},
  Finished: {},
});
type Message = typeof Message.Type;

const foldSpinner = Update.foldChild({
  update: Spinner.update,
  read: (model: Model) => Option.some(model.spinner),
  write: (model, spinner) => modifyFields(model, { spinner: () => spinner }),
  toParentMessage: (message) => Message.GotSpinnerMessage({ message }),
});

/** A parent that lifts the spinner's subscription behind its own `gate`, as the gallery does. */
const gated = (inbox: Queue.Dequeue<Message>) =>
  makeProgram({
    Model,
    init: () => ({
      model: { spinner: Spinner.init, gate: Gate.Active(), lifecycle: Lifecycle.Running() },
    }),
    update: (model, message: Message) =>
      Message.match<Update.Return<Model, Message>>(message, {
        GotSpinnerMessage: ({ message }) => foldSpinner(model, message),
        Paused: () => ({ model: modifyFields(model, { gate: () => Gate.Paused() }) }),
        Finished: () => ({ model: modifyFields(model, { lifecycle: () => Lifecycle.Finished() }) }),
      }),
    view: (model) =>
      screen(
        Spinner.view(model.spinner, {
          label: Gate.match(model.gate, { Active: () => "Working", Paused: () => "Paused" }),
        }),
      ),
    subscriptions: Subscription.aggregate(
      Subscription.lift(Spinner.subscriptions)<Model, Message>({
        read: (model) => Option.some(model.spinner),
        toParentMessage: (message) => Message.GotSpinnerMessage({ message }),
        when: (model) => Gate.match(model.gate, { Active: () => true, Paused: () => false }),
      }),
      Subscription.make<Model, Message>()(() => ({
        inbox: Subscription.persistentEntry(Stream.fromQueue(inbox)),
      })),
    ),
    result: (model) =>
      Lifecycle.match(model.lifecycle, {
        Running: () => Option.none(),
        Finished: () => Option.some("done"),
      }),
  });

describe("Spinner subscription", () => {
  it.effect("advances one frame per 80 ms and stops once the parent closes its gate", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const written = yield* Written;
        const inbox = yield* Queue.unbounded<Message>();
        const running = yield* run(gated(inbox)).pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* written.next;
        expect(yield* shown).toEqual(["⠋ Working"]);

        yield* TestClock.adjust("80 millis");
        yield* written.next;
        expect(yield* shown).toEqual(["⠙ Working"]);

        yield* TestClock.adjust("80 millis");
        yield* written.next;
        expect(yield* shown).toEqual(["⠹ Working"]);

        yield* Queue.offer(inbox, Message.Paused());
        yield* nextFrame;
        expect(yield* shown).toEqual(["⠹ Paused"]);

        yield* TestClock.adjust("400 millis");
        yield* Queue.offer(inbox, Message.Finished());

        expect(yield* Fiber.join(running)).toBe("done");
        expect(dropTrailingBlank(yield* test.scrollback)).toEqual(["⠹ Paused"]);
      }),
    ),
  );
});

const coloredChunks = (bytes: string) =>
  bytes.split("\u001b[").filter((chunk) => /^[\d;]*38;/.test(chunk));

describe("Spinner view", () => {
  it.effect.each([
    { status: "running", line: "⠸ Syncing", glyph: "38;5;78m⠸" },
    { status: "succeeded", line: "✔ Syncing", glyph: "38;5;78m✔" },
    { status: "failed", line: "✖ Syncing", glyph: "38;5;167m✖" },
    { status: "warning", line: "▲ Syncing", glyph: "38;5;172m▲" },
  ] as const)(
    "shows the $status glyph in its tone and leaves the label in the default color",
    ({ status, line, glyph }) =>
      Effect.gen(function* () {
        const { lines, bytes } = yield* render(
          Spinner.view({ frame: 3 }, { label: "Syncing", status }),
        );

        expect(lines).toEqual([line]);
        expect(coloredChunks(bytes)).toEqual([glyph]);
      }),
  );

  it.effect("colors a running frame with the requested tone", () =>
    Effect.gen(function* () {
      const { bytes } = yield* render(
        Spinner.view({ frame: 0 }, { label: "Syncing", tone: "info" }),
      );

      expect(coloredChunks(bytes)).toEqual(["38;5;99m⠋"]);
    }),
  );

  it.effect.each([
    { frame: 1, line: "⠙ Syncing" },
    { frame: 11, line: "⠙ Syncing" },
    { frame: 10.9, line: "⠋ Syncing" },
    { frame: -3, line: "⠋ Syncing" },
  ])("wraps the unicode frame $frame past the last frame", ({ frame, line }) =>
    Effect.gen(function* () {
      const { lines } = yield* render(Spinner.view({ frame }, { label: "Syncing" }));

      expect(lines).toEqual([line]);
    }),
  );

  it.effect.each([
    { frame: 1, line: "\\ Syncing" },
    { frame: 5, line: "\\ Syncing" },
    { frame: 4, line: "- Syncing" },
  ])("wraps the ASCII frame $frame by its own four frames", ({ frame, line }) =>
    Effect.gen(function* () {
      const { lines } = yield* render(Spinner.view({ frame }, { label: "Syncing" }), {
        env: { TERM: "xterm-256color", LC_ALL: "C" },
      });

      expect(lines).toEqual([line]);
    }),
  );
});
