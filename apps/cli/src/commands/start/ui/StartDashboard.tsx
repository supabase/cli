import { Box, Text } from "ink";
import { useAtomValue } from "@effect/atom-react";
import type { StackServiceState } from "@supabase/stack";
import type { StackInfo } from "@supabase/stack/internals";
import { ServiceTable } from "./ServiceTable.tsx";
import { ConnectionInfo } from "./ConnectionInfo.tsx";
import type { StartDashboardModel, StartPhase } from "./dashboard.model.ts";

export function StartDashboard({ model }: { model: StartDashboardModel }) {
  const states = useAtomValue(model.displayStatesAtom);
  const info = useAtomValue(model.stackInfoAtom);
  const phase = useAtomValue(model.phaseAtom);
  const showConnectionInfo =
    useAtomValue(model.allHealthyAtom) && info !== null && phase !== "failed";
  const statusLine = useAtomValue(model.statusLineAtom);

  return (
    <StartDashboardView
      states={states}
      info={info}
      showConnectionInfo={showConnectionInfo}
      phase={phase}
      statusLine={statusLine}
    />
  );
}

export function StartDashboardView({
  states,
  info,
  showConnectionInfo,
  phase,
  statusLine,
}: {
  states: ReadonlyArray<StackServiceState>;
  info: StackInfo | null;
  showConnectionInfo: boolean;
  phase: StartPhase;
  statusLine: string;
}) {
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>🚀 Supabase</Text>
      <Text> </Text>
      <ServiceTable states={states} />
      {showConnectionInfo && info !== null && <ConnectionInfo info={info} />}
      <Text> </Text>
      {phase === "failed" ? (
        <Text color="red">{statusLine}</Text>
      ) : (
        <Text dimColor>{statusLine}</Text>
      )}
    </Box>
  );
}
