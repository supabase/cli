import { describe, expect, it } from "@effect/vitest";
import { plainPeerAllowed } from "./ApiTlsSupport.ts";

describe("api.tls plain peer rule", () => {
  it("serves loopback, host addresses and engine subnets, never a routed peer", () => {
    const local = () => new Set(["192.168.5.4", "172.17.0.1", "10.88.0.1"]);
    const bridge = plainPeerAllowed(["172.17.0.0/16", "10.88.0.0/16"], local);
    const none = plainPeerAllowed([], local);
    for (const peer of [
      "127.0.0.1",
      "127.9.9.9",
      "::1",
      "172.17.255.254",
      "10.88.0.2",
      "192.168.5.4",
    ])
      expect(bridge(peer), peer).toBe(true);
    for (const peer of ["10.99.0.2", "172.18.0.2", "192.168.5.9", "10.89.0.1", "::2", ""])
      expect(bridge(peer), peer).toBe(false);
    for (const peer of ["127.0.0.1", "192.168.5.4", "172.17.0.1"]) expect(none(peer)).toBe(true);
    for (const peer of ["172.17.0.2", "10.88.0.2", "192.168.5.2"]) expect(none(peer)).toBe(false);
  });

  it("admits an engine subnet only while this host holds an address inside it", () => {
    const interfaces = new Set(["192.168.5.4"]);
    const allowed = plainPeerAllowed(["172.17.0.0/16"], () => interfaces);
    expect(allowed("172.17.0.2")).toBe(false);
    interfaces.add("172.17.0.1");
    expect(allowed("172.17.0.2")).toBe(true);
    interfaces.delete("172.17.0.1");
    expect(allowed("172.17.0.2")).toBe(false);
  });
});
