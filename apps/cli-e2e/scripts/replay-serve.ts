import { startReplayServer } from "../src/server/replay-server.ts";

const FIXTURES_DIR = new URL("../fixtures", import.meta.url).pathname;

function parsePort(argv: readonly string[]): number {
  const index = argv.indexOf("--port");
  if (index === -1) return 0;
  const port = Number(argv[index + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port expects an integer between 0 and 65535, got "${argv[index + 1]}"`);
  }
  return port;
}

// Recording mode wipes the committed fixtures, so a standalone server never runs in it.
if (process.env["RECORD"] === "true") {
  throw new Error("replay-serve does not support RECORD; unset it to serve the fixtures");
}

const server = await startReplayServer({
  fixturesDir: FIXTURES_DIR,
  hostname: "127.0.0.1",
  port: parsePort(process.argv.slice(2)),
  record: false,
  stagingUrl: undefined,
});

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await server.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log(JSON.stringify({ url: server.url }));
