package list

import (
	"context"
	"fmt"
	"math"
	"strconv"

	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/glamour/styles"
	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
)

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	remoteVersions, err := loadRemoteVersions(ctx, config, options...)
	if err != nil {
		return err
	}
	localVersions, err := LoadLocalVersions(fsys)
	if err != nil {
		return err
	}
	table := makeTable(remoteVersions, localVersions)
	return RenderTable(table)
}

func loadRemoteVersions(ctx context.Context, config pgconn.Config, options ...func(*pgx.ConnConfig)) ([]string, error) {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return nil, err
	}
	defer conn.Close(context.Background())
	return migration.ListRemoteMigrations(ctx, conn)
}

func makeTable(remoteMigrations, localMigrations []string) string {
	var err error
	table := "|Local|Remote|Time (UTC)|\n|-|-|-|\n"
	for i, j := 0, 0; i < len(remoteMigrations) || j < len(localMigrations); {
		remoteTimestamp := math.MaxInt
		if i < len(remoteMigrations) {
			if remoteTimestamp, err = strconv.Atoi(remoteMigrations[i]); err != nil {
				i++
				continue
			}
		}
		localTimestamp := math.MaxInt
		if j < len(localMigrations) {
			if localTimestamp, err = strconv.Atoi(localMigrations[j]); err != nil {
				j++
				continue
			}
		}
		// Top to bottom chronological order
		if localTimestamp < remoteTimestamp {
			table += fmt.Sprintf("|`%s`|` `|`%s`|\n", localMigrations[j], utils.FormatTimestampVersion(localMigrations[j]))
			j++
		} else if remoteTimestamp < localTimestamp {
			table += fmt.Sprintf("|` `|`%s`|`%s`|\n", remoteMigrations[i], utils.FormatTimestampVersion(remoteMigrations[i]))
			i++
		} else {
			table += fmt.Sprintf("|`%s`|`%s`|`%s`|\n", localMigrations[j], remoteMigrations[i], utils.FormatTimestampVersion(remoteMigrations[i]))
			i++
			j++
		}
	}
	return table
}

func RenderTable(markdown string) error {
	r, err := glamour.NewTermRenderer(
		glamour.WithStandardStyle(styles.AsciiStyle),
		glamour.WithWordWrap(-1),
	)
	if err != nil {
		return errors.Errorf("failed to initialise terminal renderer: %w", err)
	}
	out, err := r.Render(markdown)
	if err != nil {
		return errors.Errorf("failed to render markdown: %w", err)
	}
	fmt.Print(out)
	return nil
}

func LoadLocalVersions(fsys afero.Fs) ([]string, error) {
	var versions []string
	filter := func(v string) bool {
		versions = append(versions, v)
		return true
	}
	_, err := migration.ListLocalMigrations(utils.MigrationsDir, afero.NewIOFS(fsys), filter)
	return versions, err
}

func LoadPartialMigrations(version string, fsys afero.Fs) ([]string, error) {
	filter := func(v string) bool {
		return version == "" || v <= version
	}
	return migration.ListLocalMigrations(utils.MigrationsDir, afero.NewIOFS(fsys), filter)
}
