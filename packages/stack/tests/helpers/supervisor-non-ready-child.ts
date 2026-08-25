process.once("message", (value: unknown) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("stackId" in value) ||
    typeof value.stackId !== "string" ||
    !("cliVersion" in value) ||
    typeof value.cliVersion !== "string"
  ) {
    return;
  }
  process.send?.(
    {
      type: "started",
      endpoint: {
        hostname: "127.0.0.1",
        port: 1,
        url: "http://127.0.0.1:1",
      },
      owner: {
        ownershipId: value.stackId,
        ownerSessionId: "stopping-test-session",
        controlProtocolVersion: 1,
        daemonCliVersion: value.cliVersion,
        state: "stopping",
        ready: false,
      },
      attached: true,
    },
    () => process.disconnect?.(),
  );
});
