import { describe, expect, it } from "@effect/vitest";
import { beforeEach, vi } from "vitest";
import { Effect, Layer } from "effect";

import { mockTty } from "../../../tests/helpers/mocks.ts";
import { Output } from "../../shared/output/output.service.ts";
import { legacyQuietProgressTextOutputLayer } from "./legacy-quiet-progress-text-output.layer.ts";

// Mirror the shared text-layer test so the wrapped textOutputLayer resolves the
// clack spinner through a spy we can assert was never created.
const mockClack = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  spinnerFactory: vi.fn(),
  progressFactory: vi.fn(),
  spinnerHandle: {
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    clear: vi.fn(),
    isCancelled: false,
  },
  log: {
    message: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
  },
  text: vi.fn(),
  password: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  autocomplete: vi.fn(),
  multiselect: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn((_v: unknown) => false),
}));

vi.mock("@clack/prompts", () => ({
  intro: (a: unknown) => mockClack.intro(a),
  outro: (a: unknown) => mockClack.outro(a),
  log: mockClack.log,
  spinner: () => mockClack.spinnerFactory(),
  progress: () => mockClack.progressFactory(),
  text: (a: unknown) => mockClack.text(a),
  password: (a: unknown) => mockClack.password(a),
  confirm: (a: unknown) => mockClack.confirm(a),
  select: (a: unknown) => mockClack.select(a),
  autocomplete: (a: unknown) => mockClack.autocomplete(a),
  multiselect: (a: unknown) => mockClack.multiselect(a),
  cancel: (a: unknown) => mockClack.cancel(a),
  isCancel: (a: unknown) => mockClack.isCancel(a),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
  mockClack.isCancel.mockReturnValue(false);
  mockClack.spinnerFactory.mockReturnValue(mockClack.spinnerHandle);
});

describe("legacyQuietProgressTextOutputLayer", () => {
  const layer = legacyQuietProgressTextOutputLayer.pipe(
    Layer.provide(mockTty({ stdoutIsTty: true })),
  );

  it.effect("never starts a spinner, even after the spinner delay elapses", () =>
    Effect.gen(function* () {
      vi.useFakeTimers();
      const out = yield* Output;
      const task = yield* out.task("Fetching branches...");
      yield* task.message("Still fetching...");
      // Past TASK_SPINNER_DELAY_MS (200ms) — the text layer would have shown a
      // spinner by now; the quiet wrapper must not.
      vi.advanceTimersByTime(500);
      yield* task.clear();

      expect(mockClack.spinnerFactory).not.toHaveBeenCalled();
      expect(mockClack.spinnerHandle.start).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("never starts a progress bar", () =>
    Effect.gen(function* () {
      const out = yield* Output;
      const bar = yield* out.progress({ max: 3 });
      yield* bar.start("Working...");
      yield* bar.advance(1);
      yield* bar.stop("Done.");

      expect(mockClack.progressFactory).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("stays on the text layer so errors keep Go parity (red text on stderr)", () =>
    Effect.gen(function* () {
      const out = yield* Output;
      // `format === "text"` is what routes withJsonErrorHandling back to the
      // top-level text `output.fail` (red text on stderr) instead of a JSON
      // envelope on stdout — i.e. it preserves Go error-output parity.
      expect(out.format).toBe("text");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("delegates non-progress output to the text layer", () =>
    Effect.gen(function* () {
      const out = yield* Output;
      yield* out.info("hello");
      expect(mockClack.log.info).toHaveBeenCalledWith("hello");
    }).pipe(Effect.provide(layer)),
  );
});
