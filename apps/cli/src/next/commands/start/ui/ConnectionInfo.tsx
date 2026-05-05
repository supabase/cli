import { Box, Text } from "ink";
import type { StackInfo } from "@supabase/stack/effect";

const rows = [
  { emoji: "🌐", label: "API URL", key: "url" },
  { emoji: "🗄️", label: "DB URL", key: "dbUrl" },
  { emoji: "🔑", label: "Publishable key", key: "publishableKey" },
  { emoji: "🔐", label: "Secret key", key: "secretKey" },
] as const;

const labelWidth = 20;

export function ConnectionInfo({ info }: { info: StackInfo }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {rows.map((row) => (
        <Box key={row.key}>
          <Box width={labelWidth}>
            <Text>
              {row.emoji} <Text dimColor>{row.label}</Text>
            </Text>
          </Box>
          <Text bold>{info[row.key]}</Text>
        </Box>
      ))}
    </Box>
  );
}
