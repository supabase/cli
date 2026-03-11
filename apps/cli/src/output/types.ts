export type OutputFormat = "text" | "json" | "stream-json";

export type StreamEvent =
  | {
      readonly type: "log";
      readonly level: "info" | "warn" | "success" | "error";
      readonly message: string;
      readonly timestamp: string;
    }
  | {
      readonly type: "result";
      readonly data: unknown;
      readonly timestamp: string;
    }
  | {
      readonly type: "error";
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly detail?: string;
        readonly suggestion?: string;
      };
      readonly timestamp: string;
    }
  | {
      readonly type: "progress";
      readonly status: "start" | "active" | "done";
      readonly current: number;
      readonly max: number;
      readonly message: string;
      readonly timestamp: string;
    };
