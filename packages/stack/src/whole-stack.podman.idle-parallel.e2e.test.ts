import { it } from "@effect/vitest";
import { parallel } from "../tests/whole-stack/scenarios.ts";
import { functionsIdleWake, idleWake, restartIdleWake } from "../tests/whole-stack/idle.ts";
import { run } from "../tests/whole-stack/fixture.ts";

it.live("Podman: idle and wake", () => run(idleWake("podman")), { timeout: 10 * 60_000 });
it.live("Podman: restart preserves wake and idles again", () => run(restartIdleWake("podman")), {
  timeout: 10 * 60_000,
});
it.live("Podman: functions idles and wakes", () => run(functionsIdleWake("podman")), {
  timeout: 10 * 60_000,
});
it.live("Podman: parallel stack isolation", () => run(parallel("podman")), {
  timeout: 30 * 60_000,
});
