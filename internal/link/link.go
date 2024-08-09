package link

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"

	"github.com/BurntSushi/toml"
	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/internal/utils/tenant"
	"github.com/supabase/cli/pkg/api"
	cliConfig "github.com/supabase/cli/pkg/config"
	"github.com/supabase/cli/pkg/migration"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	original := toTomlBytes(map[string]interface{}{
		"api": utils.Config.Api,
		"db":  utils.Config.Db,
	})
	// 1. Check service config
	keys, err := tenant.GetApiKeys(ctx, projectRef)
	if err != nil {
		return err
	}
	LinkServices(ctx, projectRef, keys.Anon, fsys)

	// 2. Check database connection
	config := flags.GetDbConfigOptionalPassword(projectRef)
	if len(config.Password) > 0 {
		if err := linkDatabase(ctx, config, options...); err != nil {
			return err
		}
		// Save database password
		if err := credentials.Set(projectRef, config.Password); err != nil {
			fmt.Fprintln(os.Stderr, "Failed to save database password:", err)
		}
	}

	// 3. Save project ref
	if err := utils.WriteFile(utils.ProjectRefPath, []byte(projectRef), fsys); err != nil {
		return err
	}
	fmt.Fprintln(os.Stdout, "Finished "+utils.Aqua("supabase link")+".")

	// 4. Suggest config update
	updated := toTomlBytes(map[string]interface{}{
		"api": utils.Config.Api,
		"db":  utils.Config.Db,
	})
	// if lineDiff := cmp.Diff(original, updated); len(lineDiff) > 0 {
	if lineDiff := Diff(utils.ConfigPath, original, projectRef, updated); len(lineDiff) > 0 {
		fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:"), "Local config differs from linked project. Try updating", utils.Bold(utils.ConfigPath))
		fmt.Println(string(lineDiff))
	}
	return nil
}

func toTomlBytes(config any) []byte {
	var buf bytes.Buffer
	enc := toml.NewEncoder(&buf)
	enc.Indent = ""
	if err := enc.Encode(config); err != nil {
		fmt.Fprintln(utils.GetDebugLogger(), "failed to marshal toml config:", err)
	}
	return buf.Bytes()
}

func LinkServices(ctx context.Context, projectRef, anonKey string, fsys afero.Fs) {
	// Ignore non-fatal errors linking services
	var wg sync.WaitGroup
	wg.Add(6)
	go func() {
		defer wg.Done()
		if err := linkDatabaseVersion(ctx, projectRef, fsys); err != nil && viper.GetBool("DEBUG") {
			fmt.Fprintln(os.Stderr, err)
		}
	}()
	go func() {
		defer wg.Done()
		if err := linkPostgrest(ctx, projectRef); err != nil && viper.GetBool("DEBUG") {
			fmt.Fprintln(os.Stderr, err)
		}
	}()
	go func() {
		defer wg.Done()
		if err := linkPooler(ctx, projectRef, fsys); err != nil && viper.GetBool("DEBUG") {
			fmt.Fprintln(os.Stderr, err)
		}
	}()
	api := tenant.NewTenantAPI(ctx, projectRef, anonKey)
	go func() {
		defer wg.Done()
		if err := linkPostgrestVersion(ctx, api, fsys); err != nil && viper.GetBool("DEBUG") {
			fmt.Fprintln(os.Stderr, err)
		}
	}()
	go func() {
		defer wg.Done()
		if err := linkGotrueVersion(ctx, api, fsys); err != nil && viper.GetBool("DEBUG") {
			fmt.Fprintln(os.Stderr, err)
		}
	}()
	go func() {
		defer wg.Done()
		if err := linkStorageVersion(ctx, api, fsys); err != nil && viper.GetBool("DEBUG") {
			fmt.Fprintln(os.Stderr, err)
		}
	}()
	wg.Wait()
}

func linkPostgrest(ctx context.Context, projectRef string) error {
	resp, err := utils.GetSupabase().V1GetPostgrestServiceConfigWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to get postgrest config: %w", err)
	}
	if resp.JSON200 == nil {
		return errors.Errorf("%w: %s", tenant.ErrAuthToken, string(resp.Body))
	}
	updateApiConfig(*resp.JSON200)
	return nil
}

func linkPostgrestVersion(ctx context.Context, api tenant.TenantAPI, fsys afero.Fs) error {
	version, err := api.GetPostgrestVersion(ctx)
	if err != nil {
		return err
	}
	return utils.WriteFile(utils.RestVersionPath, []byte(version), fsys)
}

func updateApiConfig(config api.PostgrestConfigWithJWTSecretResponse) {
	utils.Config.Api.MaxRows = uint(config.MaxRows)
	utils.Config.Api.ExtraSearchPath = readCsv(config.DbExtraSearchPath)
	utils.Config.Api.Schemas = readCsv(config.DbSchema)
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

func linkGotrueVersion(ctx context.Context, api tenant.TenantAPI, fsys afero.Fs) error {
	version, err := api.GetGotrueVersion(ctx)
	if err != nil {
		return err
	}
	return utils.WriteFile(utils.GotrueVersionPath, []byte(version), fsys)
}

func linkStorageVersion(ctx context.Context, api tenant.TenantAPI, fsys afero.Fs) error {
	version, err := api.GetStorageVersion(ctx)
	if err != nil {
		return err
	}
	return utils.WriteFile(utils.StorageVersionPath, []byte(version), fsys)
}

func linkDatabase(ctx context.Context, config pgconn.Config, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	updatePostgresConfig(conn)
	// If `schema_migrations` doesn't exist on the remote database, create it.
	return migration.CreateMigrationTable(ctx, conn)
}

func linkDatabaseVersion(ctx context.Context, projectRef string, fsys afero.Fs) error {
	version, err := tenant.GetDatabaseVersion(ctx, projectRef)
	if err != nil {
		return err
	}
	return utils.WriteFile(utils.PostgresVersionPath, []byte(version), fsys)
}

func updatePostgresConfig(conn *pgx.Conn) {
	serverVersion := conn.PgConn().ParameterStatus("server_version")
	// Safe to assume that supported Postgres version is 10.0 <= n < 100.0
	majorDigits := len(serverVersion)
	if majorDigits > 2 {
		majorDigits = 2
	}
	// Treat error as unchanged
	if dbMajorVersion, err := strconv.ParseUint(serverVersion[:majorDigits], 10, 7); err == nil {
		utils.Config.Db.MajorVersion = uint(dbMajorVersion)
	}
}

func linkPooler(ctx context.Context, projectRef string, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().V1GetSupavisorConfigWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to get pooler config: %w", err)
	}
	if resp.JSON200 == nil {
		return errors.Errorf("%w: %s", tenant.ErrAuthToken, string(resp.Body))
	}
	for _, config := range *resp.JSON200 {
		if config.DatabaseType == api.PRIMARY {
			updatePoolerConfig(config)
		}
	}
	return utils.WriteFile(utils.PoolerUrlPath, []byte(utils.Config.Db.Pooler.ConnectionString), fsys)
}

func updatePoolerConfig(config api.SupavisorConfigResponse) {
	utils.Config.Db.Pooler.ConnectionString = config.ConnectionString
	utils.Config.Db.Pooler.PoolMode = cliConfig.PoolMode(config.PoolMode)
	if config.DefaultPoolSize != nil {
		utils.Config.Db.Pooler.DefaultPoolSize = uint(*config.DefaultPoolSize)
	}
	if config.MaxClientConn != nil {
		utils.Config.Db.Pooler.MaxClientConn = uint(*config.MaxClientConn)
	}
}
