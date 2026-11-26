import * as Command from "@effect/ui/Command";
import * as Component from "@effect/ui/Component";

import * as Terminal from "./Terminal.ts";

/**
 * The Command definition behind {@link finish}. Runs through `Terminal.Host`, a framework service,
 * so issuing it adds no requirements to a component.
 */
export const Finish: Command.Factory<{}, Component.Noop> = Command.make(
  "TerminalCommand.finish",
  { args: {} },
  () =>
    Terminal.Host.useSync((host) => {
      host.finish();
      return Component.noop;
    }),
);

/**
 * Ends `TerminalHost.run`: the final frame stays in the scrollback and the run returns the root's
 * Model as it was when the Command ran.
 */
export const finish = (): Command.Issued<Component.Noop, never, Component.Noop, "Effect"> =>
  Finish.make({});
