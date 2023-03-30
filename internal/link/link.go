package link

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/BurntSushi/toml"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/supabase/cli/pkg/api"
	"golang.org/x/term"
)

var updatedConfig map[string]interface{} = make(map[string]interface{})

func PreRun(projectRef string, fsys afero.Fs) error {
	// Sanity checks
	if !utils.ProjectRefPattern.MatchString(projectRef) {
		return errors.New("Invalid project ref format. Must be like `abcdefghijklmnopqrst`.")
	}
	return utils.LoadConfigFS(fsys)
}

func Run(ctx context.Context, projectRef, password string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	// 1. Check postgrest config
	if err := linkPostgrest(ctx, projectRef); err != nil {
		return err
	}

	// 2. Check database connection
	if len(password) > 0 {
		if err := linkDatabase(ctx, pgconn.Config{
			Host:     utils.GetSupabaseDbHost(projectRef),
			Port:     6543,
			User:     "postgres",
			Password: password,
			Database: "postgres",
		}, options...); err != nil {
			return err
		}
		// Save database password
		if err := credentials.Set(projectRef, password); err != nil {
			fmt.Fprintln(os.Stderr, "Failed to save database password:", err)
		}
	}

	// 3. Save project ref
	if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(utils.ProjectRefPath)); err != nil {
		return err
	}
	return afero.WriteFile(fsys, utils.ProjectRefPath, []byte(projectRef), 0644)
}

func PostRun(projectRef string, stdout io.Writer, fsys afero.Fs) error {
	fmt.Fprintln(stdout, "Finished "+utils.Aqua("supabase link")+".")
	if len(updatedConfig) == 0 {
		return nil
	}
	fmt.Fprintln(os.Stderr, "Local config differs from linked project. Try updating", utils.Bold(utils.ConfigPath))
	enc := toml.NewEncoder(stdout)
	enc.Indent = ""
	return enc.Encode(updatedConfig)
}

func linkPostgrest(ctx context.Context, projectRef string) error {
	resp, err := utils.GetSupabase().GetPostgRESTConfigWithResponse(ctx, projectRef)
	if err != nil {
		return err
	}
	if resp.JSON200 == nil {
		return errors.New("Authorization failed for the access token and project ref pair: " + string(resp.Body))
	}
	updateApiConfig(*resp.JSON200)
	return nil
}

func updateApiConfig(config api.PostgrestConfigResponse) {
	maxRows := uint(config.MaxRows)
	searchPath := readCsv(config.DbExtraSearchPath)
	dbSchema := readCsv(config.DbSchema)
	changed := utils.Config.Api.MaxRows != maxRows ||
		!sliceEqual(utils.Config.Api.ExtraSearchPath, searchPath) ||
		!sliceEqual(utils.Config.Api.Schemas, dbSchema)
	if changed {
		copy := utils.Config.Api
		copy.MaxRows = maxRows
		copy.ExtraSearchPath = searchPath
		copy.Schemas = dbSchema
		updatedConfig["api"] = copy
	}
}

func readCsv(line string) []string {
	var result []string
	tokens := strings.Split(line, ",")
	for _, t := range tokens {
		trimmed := strings.TrimSpace(t)
		if len(trimmed) > 0 {
			result = append(result, trimmed)
		}
	}
	return result
}

func sliceEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i, v := range a {
		if v != b[i] {
			return false
		}
	}
	return true
}

func linkDatabase(ctx context.Context, config pgconn.Config, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectRemotePostgres(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	updatePostgresConfig(conn)
	// If `schema_migrations` doesn't exist on the remote database, create it.
	batch := pgconn.Batch{}
	batch.ExecParams(repair.CREATE_VERSION_SCHEMA, nil, nil, nil, nil)
	batch.ExecParams(repair.CREATE_VERSION_TABLE, nil, nil, nil, nil)
	_, err = conn.PgConn().ExecBatch(ctx, &batch).ReadAll()
	return err
}

func updatePostgresConfig(conn *pgx.Conn) {
	serverVersion := conn.PgConn().ParameterStatus("server_version")
	// Safe to assume that supported Postgres version is 10.0 <= n < 100.0
	majorDigits := len(serverVersion)
	if majorDigits > 2 {
		majorDigits = 2
	}
	dbMajorVersion, err := strconv.ParseUint(serverVersion[:majorDigits], 10, 7)
	// Treat error as unchanged
	if err == nil && uint64(utils.Config.Db.MajorVersion) != dbMajorVersion {
		copy := utils.Config.Db
		copy.MajorVersion = uint(dbMajorVersion)
		updatedConfig["db"] = copy
	}
}

func PromptPassword(stdin *os.File) string {
	fmt.Fprint(os.Stderr, "Enter your database password: ")
	return promptPassword(stdin)
}

func PromptPasswordAllowBlank(stdin *os.File) string {
	fmt.Fprint(os.Stderr, "Enter your database password (or leave blank to skip): ")
	return promptPassword(stdin)
}

func promptPassword(stdin *os.File) string {
	bytepw, err := term.ReadPassword(int(stdin.Fd()))
	fmt.Println()
	if err != nil {
		return ""
	}
	return string(bytepw)
}
