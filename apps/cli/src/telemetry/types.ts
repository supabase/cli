export type ConsentState = "granted" | "denied";

export type TelemetryConfig = {
  consent: ConsentState;
  device_id: string;
  session_id: string;
  session_last_active: number;
};
