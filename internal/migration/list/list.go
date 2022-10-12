package list

import (
	"context"
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/charmbracelet/glamour"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/remote/commit"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, username, password, database string, fsys afero.Fs) error {
	// Sanity checks.
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
	// Connect to remote db
	projectRef, err := utils.LoadProjectRef(fsys)
	if err != nil {
		return err
	}
	conn, err := commit.ConnectRemotePostgres(ctx, username, password, database, utils.GetSupabaseDbHost(projectRef))
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	// Load remote migrations
	rows, err := conn.Query(ctx, commit.LIST_MIGRATION_VERSION)
	if err != nil {
		return err
	}
	remoteMigrations := []string{}
	for rows.Next() {
		var version string
		if err := rows.Scan(&version); err != nil {
			return err
		}
		remoteMigrations = append(remoteMigrations, version)
	}
	// Load local migrations
	if err := utils.MkdirIfNotExistFS(fsys, utils.MigrationsDir); err != nil {
		return err
	}
	localMigrations, err := afero.ReadDir(fsys, utils.MigrationsDir)
	if err != nil {
		return err
	}
	// Render table
	layoutVersion := "20060102150405"
	layoutHuman := "2006-01-02 15:04:05"
	table := "|Local|Remote|Time (UTC)|\n|-|-|-|\n"
	for i, j := 0, 0; i < len(remoteMigrations) || j < len(localMigrations); {
		var timestamp time.Time
		remoteTimestamp := math.MaxInt
		if i < len(remoteMigrations) {
			if parsed, err := strconv.Atoi(remoteMigrations[i]); err == nil {
				remoteTimestamp = parsed
				timestamp, _ = time.Parse(layoutVersion, remoteMigrations[i])
			}
		}
		localTimestamp := math.MaxInt
		if j < len(localMigrations) {
			matches := utils.MigrateFilePattern.FindStringSubmatch(localMigrations[j].Name())
			if len(matches) > 1 {
				if parsed, err := strconv.Atoi(matches[1]); err == nil {
					localTimestamp = parsed
					timestamp, _ = time.Parse(layoutVersion, matches[1])
				}
			}
		}
		// Top to bottom chronological order
		if localTimestamp < remoteTimestamp {
			table += fmt.Sprintf("|`%d`|` `|`%s`|\n", localTimestamp, timestamp.Format(layoutHuman))
			j++
		} else if remoteTimestamp < localTimestamp {
			table += fmt.Sprintf("|` `|`%d`|`%s`|\n", remoteTimestamp, timestamp.Format(layoutHuman))
			i++
		} else {
			table += fmt.Sprintf("|`%d`|`%d`|`%s`|\n", localTimestamp, remoteTimestamp, timestamp.Format(layoutHuman))
			i++
			j++
		}
	}

	r, err := glamour.NewTermRenderer(
		glamour.WithAutoStyle(),
		glamour.WithWordWrap(-1),
	)
	if err != nil {
		return err
	}
	out, err := r.Render(table)
	if err != nil {
		return err
	}
	fmt.Print(out)

	return nil
}
