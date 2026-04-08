import { Effect, ServiceMap } from "effect";

export type AnalyticsContext = {
  readonly command_run_id?: string;
  readonly command?: string;
  readonly flags_used?: ReadonlyArray<string>;
  readonly flag_values?: Record<string, unknown>;
  readonly distinct_id?: string;
  readonly groups?: {
    readonly organization?: string;
    readonly project?: string;
  };
};

export const CurrentAnalyticsContext = ServiceMap.Reference<AnalyticsContext>(
  "@supabase/cli/telemetry/CurrentAnalyticsContext",
  {
    defaultValue: () => ({}),
  },
);

export const withAnalyticsContext = (values: AnalyticsContext) =>
  Effect.updateService(CurrentAnalyticsContext, (current) => ({
    ...current,
    ...values,
    groups:
      values.groups === undefined
        ? current.groups
        : {
            ...current.groups,
            ...values.groups,
          },
  }));
