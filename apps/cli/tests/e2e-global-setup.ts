/** E2E setup intentionally performs no global stack warmup. Each scenario owns its test resource. */
export default async function globalSetup() {
  await Promise.resolve();
}
