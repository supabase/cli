import { describe, expect, it } from "@effect/vitest";
import { loopbackPeer, plainHostAllowed } from "./HttpProxy.ts";

describe("plain Host allowlist on a TLS API port", () => {
  it("admits a stack alias, localhost or an IP literal only with the API port", () => {
    for (const host of [
      "host.supabase.internal:54321",
      "HOST.DOCKER.INTERNAL:54321",
      "host.containers.internal:54321",
      "127.0.0.1:54321",
      "localhost:54321",
      "172.17.0.1:54321",
      "192.168.5.4:54321",
      "[::1]:54321",
    ])
      expect(plainHostAllowed(host, 54321), host).toBe(true);
    for (const host of [
      undefined,
      "",
      "localhost",
      "127.0.0.1",
      "localhost:80",
      "localhost:54322",
      "evil.example:54321",
      "localhost.evil.example:54321",
      "172.17.0.1",
      "172.17.0.1.nip.io:54321",
      "10.0.0.1:54322",
    ])
      expect(plainHostAllowed(host, 54321), String(host)).toBe(false);
  });

  it("accepts an allowed name without a port only on port 80", () => {
    expect(plainHostAllowed("host.supabase.internal", 80)).toBe(true);
    expect(plainHostAllowed("localhost", 80)).toBe(true);
    expect(plainHostAllowed("localhost:80", 80)).toBe(true);
    expect(plainHostAllowed("localhost:8080", 80)).toBe(false);
    expect(plainHostAllowed("evil.example", 80)).toBe(false);
    expect(plainHostAllowed("localhost", 8080)).toBe(false);
  });
});

describe("plain peer rule on a TLS API port", () => {
  it("admits loopback peers only, IPv4-mapped included", () => {
    for (const peer of ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1"])
      expect(loopbackPeer(peer), peer).toBe(true);
    for (const peer of [
      "::2",
      "",
      undefined,
      "127x.0.0.1",
      "128.0.0.1",
      "::ffff:192.168.1.2",
      "::7f00:1",
      "172.17.42.5",
    ])
      expect(loopbackPeer(peer), String(peer)).toBe(false);
  });
});
