export interface RequestEntry {
  method: string;
  pathname: string;
  headers: Record<string, string>;
  body: unknown;
}

/** The requests the replay server received since the last test cleared its log. */
export async function getRequestLog(apiUrl: string): Promise<RequestEntry[]> {
  const res = await fetch(`${apiUrl}/_ctrl/requests`);
  return res.json() as Promise<RequestEntry[]>;
}
