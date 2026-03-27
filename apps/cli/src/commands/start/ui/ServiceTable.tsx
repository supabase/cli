import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { StackServiceState } from "@supabase/stack/effect";

function statusIcon(status: string) {
  switch (status) {
    case "Healthy":
      return <Text>✅</Text>;
    case "Failed":
    case "Unhealthy":
      return <Text>❌</Text>;
    case "Stopped":
      return <Text>⏹️</Text>;
    case "Starting":
    case "Downloading":
    case "Running":
    case "Restarting":
    case "Initializing":
    case "Migrating":
      return (
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
      );
    default:
      return <Text>⏳</Text>;
  }
}

const nameWidth = 20;

export function ServiceTable({ states }: { states: ReadonlyArray<StackServiceState> }) {
  return (
    <Box flexDirection="column">
      {states.map((s) => (
        <Box key={s.name}>
          <Box width={nameWidth}>
            <Text>{s.name}</Text>
          </Box>
          <Box>
            {statusIcon(s.status)}
            <Text> {s.status}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
