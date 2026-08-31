import { Stack } from "@supabase/stack/effect";
import { Effect, Fiber, Stream } from "effect";
import { Output } from "../../shared/output/output.service.ts";

export const startStackWithProgress = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const stack = yield* Stack;

  const initialStates = yield* stack.getAllStates;
  const stateNames = new Set(initialStates.map((state) => state.name));
  const statesByName = new Map(initialStates.map((state) => [state.name, state] as const));
  const completedNames = new Set(
    initialStates
      .filter((state) => state.status === "Healthy" || state.status === "Dormant")
      .map((state) => state.name),
  );
  const prog = yield* output.progress({ max: initialStates.length });
  yield* prog.start("Waiting for services...");
  if (completedNames.size > 0) {
    yield* prog.advance(completedNames.size, "Already ready");
  }

  const updateProgress = (state: (typeof initialStates)[number]) =>
    Effect.sync(() => {
      const previousState = statesByName.get(state.name);
      statesByName.set(state.name, state);
      if (!stateNames.has(state.name) || previousState?.status === state.status) {
        return [];
      }
      return [state];
    }).pipe(
      Effect.flatMap((changedStates) =>
        Effect.forEach(
          changedStates,
          (serviceState) => {
            if (serviceState.status === "Healthy" || serviceState.status === "Dormant") {
              if (completedNames.has(serviceState.name)) {
                return Effect.void;
              }

              completedNames.add(serviceState.name);
              return prog.advance(
                1,
                serviceState.status === "Dormant"
                  ? `${serviceState.name} is dormant`
                  : `${serviceState.name} is ready`,
              );
            }

            return prog.message(`${serviceState.name}: ${serviceState.status}`);
          },
          { discard: true },
        ),
      ),
      Effect.uninterruptible,
    );

  const fiber = yield* Stream.runForEach(stack.allStateChanges, updateProgress).pipe(
    Effect.catch(() => Effect.void),
    Effect.forkChild({ startImmediately: true }),
  );

  yield* stack.start.pipe(Effect.ensuring(Fiber.interrupt(fiber)));
  const finalStates = yield* stack.getAllStates;
  yield* Effect.forEach(finalStates, updateProgress, { discard: true });
  yield* prog.stop("All services started");
});

export const printStackConnectionInfo = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const stack = yield* Stack;
  const info = yield* stack.getInfo;
  const serviceEndpoints = Object.entries(info.serviceEndpoints).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  yield* output.success("Local Supabase started", {
    api_url: info.url,
    db_url: info.dbUrl,
    publishable_key: info.publishableKey,
    secret_key: info.secretKey,
    services: Object.fromEntries(serviceEndpoints),
  });

  yield* output.info(`API URL: ${info.url}`);
  yield* output.info(`DB URL: ${info.dbUrl}`);
  yield* output.info(`Publishable key: ${info.publishableKey}`);
  yield* output.info(`Secret key: ${info.secretKey}`);

  for (const [name, endpoint] of serviceEndpoints) {
    yield* output.info(`${name}: ${endpoint}`);
  }
});
