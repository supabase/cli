import { Effect } from "effect";
import { reservePortSet } from "../../src/PortAllocator.ts";

const lease = await Effect.runPromise(
  reservePortSet([
    { field: "apiPort", selection: { kind: "automatic" } },
    { field: "dbPort", selection: { kind: "automatic" } },
  ]),
);

process.stdout.write(`${JSON.stringify(lease.ports)}\n`);

for await (const _chunk of process.stdin) {
  break;
}

await Effect.runPromise(lease.releaseAll);
