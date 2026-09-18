import { it } from "@effect/vitest";
import { Effect } from "effect";
import { allEager, defaultLifecycle, parallel } from "../tests/whole-stack/scenarios.ts";
import { idleWake } from "../tests/whole-stack/idle.ts";
import { servicesLayer } from "../tests/whole-stack/fixture.ts";

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(servicesLayer));

it.live(
  "Docker: default database eager lifecycle and reopen",
  () => run(defaultLifecycle("docker")),
  {
    timeout: 15 * 60_000,
  },
);
it.live("Docker: all services eager", () => run(allEager("docker")), { timeout: 15 * 60_000 });
it.live("Docker: idle and wake", () => run(idleWake("docker")), { timeout: 10 * 60_000 });
it.live("Docker: parallel stack isolation", () => run(parallel("docker")), {
  timeout: 30 * 60_000,
});
