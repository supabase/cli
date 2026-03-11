import { Effect, Fiber, Stream } from "effect";
import { Stack } from "@supabase/stack/internals";
import { Output } from "../../output/output.service.ts";
import { toDisplayStates } from "./ui/display-states.ts";

export const startStackWithProgress = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const stack = yield* Stack;

  yield* output.intro("Starting local Supabase stack...");

  const initialRawStates = yield* stack.getAllStates();
  const initialDisplayStates = toDisplayStates(initialRawStates);
  const displayNames = new Set(initialDisplayStates.map((state) => state.name));
  const rawStatesByName = new Map(initialRawStates.map((state) => [state.name, state]));
  const displayStatesByName = new Map(
    initialDisplayStates.map((state) => [state.name, state] as const),
  );
  const readyNames = new Set(
    initialDisplayStates.filter((state) => state.status === "Healthy").map((state) => state.name),
  );
  const prog = yield* output.progress({ max: initialDisplayStates.length });
  yield* prog.start("Waiting for services...");

  const fiber = yield* Stream.runForEach(stack.allStateChanges(), (state) =>
    Effect.sync(() => {
      rawStatesByName.set(state.name, state);

      const nextDisplayStates = toDisplayStates([...rawStatesByName.values()]);
      const nextDisplayStatesByName = new Map(
        nextDisplayStates.map((displayState) => [displayState.name, displayState] as const),
      );
      const changedDisplayStates = [...displayNames]
        .map((name) => nextDisplayStatesByName.get(name))
        .filter((displayState) => displayState !== undefined)
        .filter(
          (displayState) =>
            displayStatesByName.get(displayState.name)?.status !== displayState.status,
        );

      displayStatesByName.clear();
      for (const name of displayNames) {
        const nextDisplayState = nextDisplayStatesByName.get(name);
        if (nextDisplayState !== undefined) {
          displayStatesByName.set(name, nextDisplayState);
        }
      }

      return changedDisplayStates;
    }).pipe(
      Effect.flatMap((changedDisplayStates) =>
        Effect.forEach(
          changedDisplayStates,
          (displayState) => {
            if (displayState.status === "Healthy") {
              if (readyNames.has(displayState.name)) {
                return Effect.void;
              }

              readyNames.add(displayState.name);
              return prog.advance(1, `${displayState.name} is ready`);
            }

            return prog.message(`${displayState.name}: ${displayState.status}`);
          },
          { discard: true },
        ),
      ),
    ),
  ).pipe(
    Effect.catch(() => Effect.void),
    Effect.forkChild({ startImmediately: true }),
  );

  yield* stack.start();
  yield* prog.stop("All services started");
  yield* Fiber.interrupt(fiber);
});

export const printStackConnectionInfo = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const stack = yield* Stack;
  const info = yield* stack.getInfo();

  yield* output.success("Local Supabase started", {
    api_url: info.url,
    db_url: info.dbUrl,
    anon_key: info.anonJwt,
    service_role_key: info.serviceRoleJwt,
  });

  yield* output.info(`API URL: ${info.url}`);
  yield* output.info(`DB URL: ${info.dbUrl}`);
  yield* output.info(`anon key: ${info.anonJwt}`);
  yield* output.info(`service_role key: ${info.serviceRoleJwt}`);
});
