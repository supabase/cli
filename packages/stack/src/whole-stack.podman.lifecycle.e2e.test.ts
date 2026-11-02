import { it } from "@effect/vitest";
import { allEager, defaultLifecycle, writeConfinement } from "../tests/whole-stack/scenarios.ts";
import { run } from "../tests/whole-stack/fixture.ts";

it.live(
  "Podman: default database eager lifecycle and reopen",
  () => run(defaultLifecycle("podman")),
  {
    timeout: 15 * 60_000,
  },
);
it.live("Podman: all services eager", () => run(allEager("podman")), { timeout: 15 * 60_000 });
it.live(
  "Podman: writes stay confined to the state root and artifact cache",
  () => run(writeConfinement("podman")),
  { timeout: 15 * 60_000 },
);
