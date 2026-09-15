export type OutputFormat = "text" | "json" | "stream-json";

export type StreamEvent =
  | {
      readonly type: "log";
      readonly level: "info" | "warn" | "success" | "error";
      readonly message: string;
      readonly timestamp: string;
    }
  | {
      readonly type: "log-entry";
      readonly timestamp: string;
      readonly service: string;
      readonly stream: "stdout" | "stderr" | "internal";
      readonly line: string;
      readonly source: "history" | "live";
    }
  | {
      readonly type: "realtime-frame";
      readonly timestamp: string;
      readonly seq: number;
      readonly category: string;
      readonly event: string;
      readonly label: string;
      readonly line: string;
      readonly payload: unknown;
      readonly latencyMs?: number;
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
