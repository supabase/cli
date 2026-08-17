process.once("message", () => {
  process.send?.({
    type: "error",
    message: "Supervisor test runtime failed after binding",
  });
});
