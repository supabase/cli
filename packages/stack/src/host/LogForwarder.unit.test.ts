import { expect, it } from "@effect/vitest";
import { batchBytes, bodies } from "./LogForwarder.ts";

const encoder = new TextEncoder();

const eventWith = (message: string) => ({
  event: {
    id: "00000000-0000-8000-8000-000000000000",
    appname: "database" as const,
    event_message: message,
    timestamp: "2026-09-30T10:00:00.000Z",
    metadata: {},
  },
});

// Ten events whose single `{"batch":[...]}` body would be exactly `total` bytes.
const eventsForBody = (total: number) => {
  const empty = JSON.stringify(eventWith("").event).length;
  const available = total - '{"batch":[]}'.length - 9 - 10 * empty;
  return Array.from({ length: 10 }, (_, index) =>
    eventWith("x".repeat(Math.floor(available / 10) + (index === 9 ? available % 10 : 0))),
  );
};

const sizes = (events: ReturnType<typeof eventsForBody>) =>
  bodies(events).map(({ body }) => encoder.encode(body).length);

it("keeps a body whose full JSON envelope is exactly the byte limit in one request", () => {
  expect(sizes(eventsForBody(batchBytes))).toEqual([batchBytes]);
});

it("splits a body that the JSON envelope would push past the byte limit", () => {
  const split = sizes(eventsForBody(batchBytes + 1));
  expect(split).toHaveLength(2);
  expect(split.every((size) => size <= batchBytes)).toBe(true);
});
