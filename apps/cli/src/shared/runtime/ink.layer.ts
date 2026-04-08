import { Effect, Layer } from "effect";

import { Ink } from "./ink.service.ts";

export const inkLayer = Layer.sync(Ink, () =>
  Ink.of({
    render: (element) =>
      Effect.promise(async () => {
        const { render } = await import("ink");
        return render(element, { exitOnCtrlC: false });
      }),
  }),
);
