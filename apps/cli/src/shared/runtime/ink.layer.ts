import { Effect, Layer } from "effect";

import { Ink } from "./ink.service.ts";

export const inkLayer = Layer.sync(Ink, () =>
  Ink.of({
    render: (element) =>
      Effect.tryPromise(() => import("ink")).pipe(
        Effect.flatMap(({ render }) => Effect.sync(() => render(element, { exitOnCtrlC: false }))),
        // Ink is a package dependency of the CLI; failure to load it is a
        // deployment/programming defect rather than a recoverable command
        // failure, so preserve the service's never-error contract.
        Effect.orDie,
      ),
  }),
);
