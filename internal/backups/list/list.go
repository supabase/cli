package list

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
)

func Run(ctx context.Context) error {
	resp, err := utils.GetSupabase().V1ListAllBackupsWithResponse(ctx, flags.ProjectRef)
	if err != nil {
		return errors.Errorf("failed to list physical backups: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected list backup status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	switch utils.OutputFormat.Value {
	case utils.OutputPretty:
		if len(resp.JSON200.Backups) > 0 {
			return listLogicalBackups(*resp.JSON200)
		}
		table := `REGION|WALG|PITR|EARLIEST TIMESTAMP|LATEST TIMESTAMP
|-|-|-|-|-|
`
		table += fmt.Sprintf(
			"|`%s`|`%t`|`%t`|`%d`|`%d`|\n",
			utils.FormatRegion(resp.JSON200.Region),
			resp.JSON200.WalgEnabled,
			resp.JSON200.PitrEnabled,
			cast.Val(resp.JSON200.PhysicalBackupData.EarliestPhysicalBackupDateUnix, 0),
			cast.Val(resp.JSON200.PhysicalBackupData.LatestPhysicalBackupDateUnix, 0),
		)
		return list.RenderTable(table)
	case utils.OutputEnv:
		return errors.Errorf("--output env flag is not supported")
	}
	return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, *resp.JSON200)
}

const (
	BACKUP_LOGICAL  = "LOGICAL"
	BACKUP_PHYSICAL = "PHYSICAL"
)

func listLogicalBackups(resp api.V1BackupsResponse) error {
	table := `REGION|BACKUP TYPE|STATUS|CREATED AT (UTC)
|-|-|-|-|
`
	for _, backup := range resp.Backups {
		backupType := BACKUP_LOGICAL
		if backup.IsPhysicalBackup {
			backupType = BACKUP_PHYSICAL
		}
		table += fmt.Sprintf(
			"|`%s`|`%s`|`%s`|`%s`|\n",
			utils.FormatRegion(resp.Region),
			backupType,
			backup.Status,
			utils.FormatTimestamp(backup.InsertedAt),
		)
	}
	return list.RenderTable(table)
}
