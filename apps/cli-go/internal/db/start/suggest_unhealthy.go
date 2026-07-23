package start

import (
	"fmt"
	"runtime"
	"strings"

	"github.com/supabase/cli/internal/utils"
)

// SuggestFromUnhealthyLogs returns a CmdSuggestion for common local-stack
// startup failures seen after image upgrades or wrong-arch pulls
// (see https://github.com/supabase/supabase/issues/48224).
func SuggestFromUnhealthyLogs(logs string) string {
	lower := strings.ToLower(logs)
	var parts []string

	if strings.Contains(lower, "exec format error") {
		arch := runtime.GOARCH
		parts = append(parts, fmt.Sprintf(
			"A container failed with \"exec format error\" (wrong CPU architecture image).\n"+
				"Try removing the mismatched images and restarting for linux/%s:\n"+
				"  %s\n"+
				"  docker image prune -f\n"+
				"  %s",
			arch,
			utils.Aqua("supabase stop --no-backup"),
			utils.Aqua("supabase start"),
		))
	}

	if strings.Contains(lower, "migrations_name_key") ||
		(strings.Contains(lower, "migration failed") && strings.Contains(lower, "duplicate key")) {
		parts = append(parts, fmt.Sprintf(
			"Storage migrations failed against an existing database volume (often after upgrading images while restoring a backup).\n"+
				"Reset local data and start fresh:\n"+
				"  %s\n"+
				"  %s",
			utils.Aqua("supabase stop --no-backup"),
			utils.Aqua("supabase start"),
		))
	}

	if strings.Contains(lower, "err_invalid_package_config") ||
		strings.Contains(lower, "invalid package config") {
		parts = append(parts, fmt.Sprintf(
			"Studio image looks corrupted or incomplete. Remove it and re-pull:\n"+
				"  %s\n"+
				"  docker image rm -f $(docker images -q supabase/studio) 2>/dev/null\n"+
				"  %s",
			utils.Aqua("supabase stop --no-backup"),
			utils.Aqua("supabase start"),
		))
	}

	return strings.Join(parts, "\n\n")
}
