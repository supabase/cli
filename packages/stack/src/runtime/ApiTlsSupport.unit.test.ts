import { describe, expect, it } from "@effect/vitest";
import { plainPeerAdmitted, plainPeerAllowed } from "./ApiTlsSupport.ts";

const docker = { subnet: "172.17.0.0/16", gateway: "172.17.0.1" };
const podman = { subnet: "10.88.0.0/16", gateway: "10.88.0.1" };

describe("api.tls plain peer rule", () => {
  it("serves loopback, host addresses and engine networks, never a routed peer", () => {
    const local = () => new Set(["192.168.5.4", "172.17.0.1", "10.88.0.1"]);
    const bridge = plainPeerAllowed([docker, podman], local);
    const none = plainPeerAllowed([], local);
    const admitted: ReadonlyArray<readonly [string, string]> = [
      ["127.0.0.1", "127.0.0.1"],
      ["127.9.9.9", "127.0.0.1"],
      ["::1", "::1"],
      ["172.17.255.254", "172.17.0.1"],
      ["10.88.0.2", "10.88.0.1"],
      ["192.168.5.4", "192.168.5.4"],
    ];
    const refused: ReadonlyArray<readonly [string, string]> = [
      ["10.99.0.2", "192.168.5.4"],
      ["172.18.0.2", "172.17.0.1"],
      ["192.168.5.9", "192.168.5.4"],
      ["10.89.0.1", "10.88.0.1"],
      ["::2", "::1"],
      ["", ""],
    ];
    for (const [peer, to] of admitted) expect(bridge(peer, to), peer).toBe(true);
    for (const [peer, to] of refused) expect(bridge(peer, to), peer).toBe(false);
    for (const peer of ["127.0.0.1", "192.168.5.4", "172.17.0.1"])
      expect(none(peer, "192.168.5.4")).toBe(true);
    for (const peer of ["172.17.0.2", "10.88.0.2", "192.168.5.2"])
      expect(none(peer, "172.17.0.1")).toBe(false);
  });

  it("admits an engine network's peer only when it connected to that network's gateway", () => {
    /* Linux docker: a container on the default bridge reaches the host at docker0's address. */
    const linux = plainPeerAllowed([docker], () => new Set(["172.17.0.1", "192.168.1.5"]));
    expect(linux("172.17.0.4", "172.17.0.1")).toBe(true);
    expect(linux("192.168.1.50", "192.168.1.5")).toBe(false);
    /* Rootful podman: a container on the podman bridge reaches the host at its gateway. */
    const rootful = plainPeerAllowed([podman], () => new Set(["10.88.0.1"]));
    expect(rootful("10.88.0.4", "10.88.0.1")).toBe(true);
    /* Docker Desktop: the engine's bridge lives in its VM, so this host never holds the gateway,
       and a LAN peer inside the same range reaches the host's LAN address. */
    const desktop = plainPeerAllowed([docker], () => new Set(["172.17.20.5"]));
    expect(desktop("172.17.30.9", "172.17.20.5")).toBe(false);
    /* A VPN route inside docker0's range: its peer connects to the VPN address, not docker0's. */
    const vpn = plainPeerAllowed([docker], () => new Set(["172.17.0.1", "172.17.20.5"]));
    expect(vpn("172.17.20.9", "172.17.20.5")).toBe(false);
    expect(vpn("172.17.0.2", "172.17.0.1")).toBe(true);
  });

  it("never admits by a network without a gateway", () => {
    const allowed = plainPeerAllowed([{ subnet: "172.17.0.0/16", gateway: "" }], () => new Set());
    expect(allowed("172.17.0.4", "")).toBe(false);
    expect(allowed("172.17.0.4", "172.17.0.1")).toBe(false);
  });
});

describe("api.tls plain peer rule with the self-check's arrivals", () => {
  /* `peer@local`: the database container's self-check through a `host-gateway` set to the LAN
     address, on Linux docker, where this host holds docker0's gateway. */
  const db = "172.17.0.2@192.168.1.10";
  const linux = ["172.17.0.1", "192.168.1.10"];
  const lan = { subnet: "192.168.1.0/24", gateway: "192.0.2.1" };
  const rows: ReadonlyArray<
    readonly [
      label: string,
      networks: ReadonlyArray<{ readonly subnet: string; readonly gateway: string }>,
      arrivals: ReadonlyArray<string>,
      host: ReadonlyArray<string>,
      connection: string,
      admitted: boolean,
    ]
  > = [
    ["a sibling at the arrival's local", [docker], [db], linux, "172.17.0.5@192.168.1.10", true],
    ["the arrival itself", [docker], [db], linux, db, true],
    [
      "a LAN peer at the arrival's local",
      [docker],
      [db],
      linux,
      "192.168.1.20@192.168.1.10",
      false,
    ],
    [
      "a sibling at another local",
      [docker],
      [db],
      [...linux, "10.0.0.9"],
      "172.17.0.5@10.0.0.9",
      false,
    ],
    [
      "the arrival's peer at another local",
      [docker],
      [db],
      [...linux, "10.0.0.9"],
      "172.17.0.2@10.0.0.9",
      false,
    ],
    ["a sibling before any network", [], [db], linux, "172.17.0.5@192.168.1.10", false],
    ["a sibling at the gateway", [docker], [], ["172.17.0.1"], "172.17.0.5@172.17.0.1", true],
    /* Docker Desktop: the bridge lives in its VM, so this host never holds the gateway. */
    [
      "Desktop's host arrival",
      [docker],
      ["172.17.20.5@172.17.20.5"],
      ["172.17.20.5"],
      "172.17.30.9@172.17.20.5",
      false,
    ],
    [
      "a VPN-in-range arrival",
      [docker],
      ["172.17.0.2@172.17.20.5"],
      ["172.17.0.1", "172.17.20.5"],
      "172.17.20.9@172.17.20.5",
      false,
    ],
    [
      "a relay's host arrival",
      [docker],
      ["192.168.1.10@192.168.1.10"],
      linux,
      "172.17.0.5@192.168.1.10",
      false,
    ],
    [
      "an arrival from the gateway",
      [docker],
      ["172.17.0.1@192.168.1.10"],
      linux,
      "172.17.0.5@192.168.1.10",
      false,
    ],
    [
      "a loopback arrival",
      [docker],
      ["127.0.0.1@192.168.1.10"],
      linux,
      "172.17.0.5@192.168.1.10",
      false,
    ],
    [
      "an arrival from another network",
      [docker],
      ["10.88.0.2@192.168.1.10"],
      linux,
      "172.17.0.5@192.168.1.10",
      false,
    ],
    /* macvlan on the LAN: its gateway is the router, not this host. */
    [
      "a macvlan LAN peer",
      [{ subnet: "192.168.1.0/24", gateway: "192.168.1.1" }],
      ["192.168.1.50@192.168.1.200"],
      ["192.168.1.10", "192.168.1.200"],
      "192.168.1.20@192.168.1.200",
      false,
    ],
    [
      "a network without a gateway",
      [{ subnet: "172.17.0.0/16", gateway: "" }],
      [db],
      ["192.168.1.10"],
      "172.17.0.5@192.168.1.10",
      false,
    ],
    [
      "a sibling at loopback, gateway held",
      [lan],
      ["192.168.1.14@127.0.0.1"],
      ["192.0.2.1"],
      "192.168.1.13@127.0.0.1",
      true,
    ],
    [
      "a sibling at loopback, gateway not held",
      [lan],
      ["192.168.1.14@127.0.0.1"],
      [],
      "192.168.1.13@127.0.0.1",
      false,
    ],
  ];
  const arrival = (text: string) => {
    const [peer = "", local = ""] = text.split("@");
    return { peer, local };
  };

  it("admits loopback without reading this host's addresses", () => {
    let reads = 0;
    const admitted = plainPeerAdmitted([docker], [], () => {
      reads++;
      return new Set(["172.17.0.1"]);
    });
    expect(admitted("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(admitted("::1", "::1")).toBe(true);
    expect(reads).toBe(0);
    expect(admitted("172.17.0.5", "172.17.0.1")).toBe(true);
    expect(reads).toBe(1);
  });

  it.each(rows)("%s", (_label, networks, arrivals, host, connection, admitted) => {
    const { peer, local } = arrival(connection);
    expect(
      plainPeerAdmitted(networks, arrivals.map(arrival), () => new Set(host))(peer, local),
    ).toBe(admitted);
  });
});
