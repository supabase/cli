import { describe, expect, it } from "vitest";
import { managedPortIntents } from "./managed-port-intents.ts";

const stackConfig = {
  mode: "docker",
  pooler: {},
} satisfies Parameters<typeof managedPortIntents>[0];

describe("managedPortIntents", () => {
  it("maps the configured pooler port to the transaction listener by default", () => {
    expect(
      managedPortIntents(stackConfig, {
        document: { db: { pooler: { port: 6543 } } },
      }).document,
    ).toEqual({ db: { pooler: { port: 6543, transaction_port: 6543 } } });
  });

  it("maps the configured pooler port to the session listener when requested", () => {
    expect(
      managedPortIntents(stackConfig, {
        document: { db: { pooler: { port: 6544, pool_mode: "session" } } },
      }).document,
    ).toEqual({
      db: { pooler: { port: 6544, pool_mode: "session", session_port: 6544 } },
    });
  });

  it("leaves the document unchanged when the pooler port is absent", () => {
    const document = { db: { pooler: { pool_mode: "session" } } };
    expect(managedPortIntents(stackConfig, { document }).document).toBe(document);
  });
});
