import { describe, expect, it } from "vitest";

import { LegacyPgDeltaSslProbeError } from "./legacy-pgdelta-ssl-probe.service.ts";
import {
  legacyInterpretSslProbeByte,
  legacyParseSslProbeTarget,
} from "./legacy-pgdelta-ssl-probe.layer.ts";

describe("legacyParseSslProbeTarget", () => {
  it("parses host/port and the connect_timeout (seconds → ms)", () => {
    expect(
      legacyParseSslProbeTarget("postgresql://u:p@db.example.com:6543/postgres?connect_timeout=30"),
    ).toEqual({ host: "db.example.com", port: 6543, timeoutMs: 30_000 });
  });

  it("defaults the port to 5432 and the timeout to 10s when absent", () => {
    expect(legacyParseSslProbeTarget("postgresql://u:p@db.example.com/postgres")).toEqual({
      host: "db.example.com",
      port: 5432,
      timeoutMs: 10_000,
    });
  });

  it("treats a zero/invalid connect_timeout as the 10s default", () => {
    expect(legacyParseSslProbeTarget("postgresql://h:5432/db?connect_timeout=0").timeoutMs).toBe(
      10_000,
    );
  });

  it("strips the brackets around an IPv6-literal host so net.connect dials the address", () => {
    expect(legacyParseSslProbeTarget("postgresql://u:p@[::1]:5432/postgres")).toEqual({
      host: "::1",
      port: 5432,
      timeoutMs: 10_000,
    });
  });

  it("leaves a plain hostname untouched", () => {
    expect(legacyParseSslProbeTarget("postgresql://u:p@db.example.com:5432/postgres").host).toBe(
      "db.example.com",
    );
  });
});

describe("legacyInterpretSslProbeByte", () => {
  it("maps 'S' (0x53) to TLS-capable", () => {
    expect(legacyInterpretSslProbeByte(0x53)).toBe("tls");
  });

  it("maps 'N' (0x4e) to refused", () => {
    expect(legacyInterpretSslProbeByte(0x4e)).toBe("refused");
  });

  it("throws a probe error for an unexpected byte or empty response", () => {
    expect(() => legacyInterpretSslProbeByte(0x00)).toThrow(LegacyPgDeltaSslProbeError);
    expect(() => legacyInterpretSslProbeByte(undefined)).toThrow(LegacyPgDeltaSslProbeError);
  });
});
