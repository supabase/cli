import { create } from "../src/index.ts";
import { inspect } from "node:util";
const [root, cacheRoot] = process.argv.slice(2);
if (root === undefined || cacheRoot === undefined) throw new Error("Client fixture roots missing");
const stack = await create({
  projectRoot: root,
  stateRoot: `${root}/state`,
  cacheRoot,
  runtime: "native",
});
let failed = false;
let logs = "";
let logReaderFailure: unknown;
let readLogs: Promise<void> | undefined;
try {
  const mail = await stack.services.create({
    service: "mail",
    config: {},
    endpoints: { http: { port: "auto" } },
  });
  // oxlint-disable-next-line effecttsgo/async-function -- This fixture exercises the Promise client API.
  readLogs = (async () => {
    for await (const entry of mail.logs()) {
      logs += `[${entry.stream}] ${new TextDecoder().decode(entry.bytes)}`;
    }
  })().catch((cause) => {
    logReaderFailure = cause;
  });
  await mail.start();
  await mail.ready();
  process.stdout.write(`${JSON.stringify({ stackId: stack.id, instanceId: mail.id })}\n`);
} catch (cause) {
  failed = true;
  await stack.destroy();
  throw cause;
} finally {
  await stack.close();
  await readLogs;
  if (failed) {
    process.stderr.write(
      `Mailpit logs:\n${logs}${logReaderFailure === undefined ? "" : `\nLog reader failed: ${inspect(logReaderFailure)}`}\n`,
    );
  }
}
