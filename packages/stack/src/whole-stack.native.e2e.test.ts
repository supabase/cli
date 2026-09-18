import { it } from "@effect/vitest";
import { Effect } from "effect";
import { allEager, defaultLifecycle, parallel } from "../tests/whole-stack/scenarios.ts";
import { idleWake } from "../tests/whole-stack/idle.ts";
import { servicesLayer } from "../tests/whole-stack/fixture.ts";

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(servicesLayer));

it.live(
  "native: default database eager lifecycle and reopen",
  () => run(defaultLifecycle("native")),
  {
    timeout: 15 * 60_000,
  },
);
it.live("native: all services eager", () => run(allEager("native")), { timeout: 15 * 60_000 });
it.live("native: idle and wake", () => run(idleWake("native")), { timeout: 10 * 60_000 });
it.live("native: parallel stack isolation", () => run(parallel("native")), {
  timeout: 30 * 60_000,
});
