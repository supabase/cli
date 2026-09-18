import { create } from "../src/index.ts";
const [root, cacheRoot] = process.argv.slice(2);
if (root === undefined || cacheRoot === undefined) throw new Error("Client fixture roots missing");
const stack = await create({
  projectRoot: root,
  stateRoot: `${root}/state`,
  cacheRoot,
  runtime: "native",
});
try {
  const mail = await stack.services.create({
    service: "mail",
    config: {},
    endpoints: { http: { port: "auto" } },
  });
  await mail.start();
  await mail.ready();
  process.stdout.write(`${JSON.stringify({ stackId: stack.id, instanceId: mail.id })}\n`);
} catch (cause) {
  await stack.destroy();
  throw cause;
} finally {
  await stack.close();
}
