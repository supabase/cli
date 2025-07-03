package link

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"sync"

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
	"github.com/supabase/cli/pkg/cast"
	cliConfig "github.com/supabase/cli/pkg/config"
	"github.com/supabase/cli/pkg/diff"
	"github.com/supabase/cli/pkg/migration"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	copy := utils.Config.Clone()
	original, err := cliConfig.ToTomlBytes(copy)
	if err != nil {
		fmt.Fprintln(utils.GetDebugLogger(), err)
	}

	if err := checkRemoteProjectStatus(ctx, projectRef, fsys); err != nil {
		return err
	}

	// 1. Check service config
	keys, err := tenant.GetApiKeys(ctx, projectRef)
	if err != nil {
		return err
	}
	LinkServices(ctx, projectRef, keys.Anon, fsys)

	// 2. Check database connection
	config := flags.GetDbConfigOptionalPassword(projectRef)
	if len(config.Password) > 0 {
		if err := linkDatabase(ctx, config, fsys, options...); err != nil {
			return err
		}
		// Save database password
		if err := credentials.StoreProvider.Set(projectRef, config.Password); err != nil {
			fmt.Fprintln(os.Stderr, "Failed to save database password:", err)
		}
	}

	// 3. Save project ref
	if err := utils.WriteFile(utils.ProjectRefPath, []byte(projectRef), fsys); err != nil {
		return err
	}
	fmt.Fprintln(os.Stdout, "Finished "+utils.Aqua("supabase link")+".")

	// 4. Suggest config update
	updated, err := cliConfig.ToTomlBytes(utils.Config.Clone())
	if err != nil {
		fmt.Fprintln(utils.GetDebugLogger(), err)
	}

	if lineDiff := diff.Diff(utils.ConfigPath, original, projectRef, updated); len(lineDiff) > 0 {
		fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:"), "Local config differs from linked project. Try updating", utils.Bold(utils.ConfigPath))
		fmt.Println(string(lineDiff))
	}
	return nil
}

func LinkServices(ctx context.Context, projectRef, anonKey string, fsys afero.Fs) {
	// Ignore non-fatal errors linking services
	var wg sync.WaitGroup
	wg.Add(8)
	go func() {
		defer wg.Done()
		if err := linkDatabaseSettings(ctx, projectRef); err != nil && viper.GetBool("DEBUG") {
			fmt.Fprintln(os.Stderr, err)
		}
	}()
	go func() {
		defer wg.Done()
		if err := linkNetworkRestrictions(ctx, projectRef); err != nil && viper.GetBool("DEBUG") {
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
		if err := linkGotrue(ctx, projectRef); err != nil && viper.GetBool("DEBUG") {
			fmt.Fprintln(os.Stderr, err)
		}
	}()
	go func() {
		defer wg.Done()
		if err := linkStorage(ctx, projectRef); err != nil && viper.GetBool("DEBUG") {
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
	wg.Wait()
}

func linkPostgrest(ctx context.Context, projectRef string) error {
	resp, err := utils.GetSupabase().V1GetPostgrestServiceConfigWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to read API config: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected API config status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	utils.Config.Api.FromRemoteApiConfig(*resp.JSON200)
	return nil
}

func linkPostgrestVersion(ctx context.Context, api tenant.TenantAPI, fsys afero.Fs) error {
	version, err := api.GetPostgrestVersion(ctx)
	if err != nil {
		return err
	}
	return utils.WriteFile(utils.RestVersionPath, []byte(version), fsys)
}

func linkGotrue(ctx context.Context, projectRef string) error {
	resp, err := utils.GetSupabase().V1GetAuthServiceConfigWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to read Auth config: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected Auth config status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	utils.Config.Auth.FromRemoteAuthConfig(*resp.JSON200)
	return nil
}

func linkGotrueVersion(ctx context.Context, api tenant.TenantAPI, fsys afero.Fs) error {
	version, err := api.GetGotrueVersion(ctx)
	if err != nil {
		return err
	}
	return utils.WriteFile(utils.GotrueVersionPath, []byte(version), fsys)
}

func linkStorage(ctx context.Context, projectRef string) error {
	resp, err := utils.GetSupabase().V1GetStorageConfigWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to read Storage config: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected Storage config status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	utils.Config.Storage.FromRemoteStorageConfig(*resp.JSON200)
	return nil
}

const GET_LATEST_STORAGE_MIGRATION = "SELECT name FROM storage.migrations ORDER BY id DESC LIMIT 1"

func linkStorageVersion(ctx context.Context, conn *pgx.Conn, fsys afero.Fs) error {
	var name string
	if err := conn.QueryRow(ctx, GET_LATEST_STORAGE_MIGRATION).Scan(&name); err != nil {
		return errors.Errorf("failed to fetch storage migration: %w", err)
	}
	return utils.WriteFile(utils.StorageVersionPath, []byte(name), fsys)
}

func linkDatabaseSettings(ctx context.Context, projectRef string) error {
	resp, err := utils.GetSupabase().V1GetPostgresConfigWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to read DB config: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected DB config status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	utils.Config.Db.Settings.FromRemotePostgresConfig(*resp.JSON200)
	return nil
}

func linkNetworkRestrictions(ctx context.Context, projectRef string) error {
	resp, err := utils.GetSupabase().V1GetNetworkRestrictionsWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to read network restrictions: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected network restrictions status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	utils.Config.Db.NetworkRestrictions.FromRemoteNetworkRestrictions(*resp.JSON200)
	return nil
}

func linkDatabase(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	updatePostgresConfig(conn)
	if err := linkStorageVersion(ctx, conn, fsys); err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
	// If `schema_migrations` doesn't exist on the remote database, create it.
	if err := migration.CreateMigrationTable(ctx, conn); err != nil {
		return err
	}
	return migration.CreateSeedTable(ctx, conn)
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
	resp, err := utils.GetSupabase().V1GetPoolerConfigWithResponse(ctx, projectRef)
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
	if value, err := config.DefaultPoolSize.Get(); err == nil {
		utils.Config.Db.Pooler.DefaultPoolSize = cast.IntToUint(value)
	}
	if value, err := config.MaxClientConn.Get(); err == nil {
		utils.Config.Db.Pooler.MaxClientConn = cast.IntToUint(value)
	}
}

var errProjectPaused = errors.New("project is paused")

func checkRemoteProjectStatus(ctx context.Context, projectRef string, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().V1GetProjectWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to retrieve remote project status: %w", err)
	}
	switch resp.StatusCode() {
	case http.StatusNotFound:
		// Ignore not found error to support linking branch projects
		return nil
	case http.StatusOK:
		// resp.JSON200 is not nil, proceed
	default:
		return errors.New("Unexpected error retrieving remote project status: " + string(resp.Body))
	}

	switch resp.JSON200.Status {
	case api.V1ProjectWithDatabaseResponseStatusINACTIVE:
		utils.CmdSuggestion = fmt.Sprintf("An admin must unpause it from the Supabase dashboard at %s", utils.Aqua(fmt.Sprintf("%s/project/%s", utils.GetSupabaseDashboardURL(), projectRef)))
		return errors.New(errProjectPaused)
	case api.V1ProjectWithDatabaseResponseStatusACTIVEHEALTHY:
		// Project is in the desired state, do nothing
	default:
		fmt.Fprintf(os.Stderr, "%s: Project status is %s instead of Active Healthy. Some operations might fail.\n", utils.Yellow("WARNING"), resp.JSON200.Status)
	}

	// Update postgres image version to match the remote project
	if version := resp.JSON200.Database.Version; len(version) > 0 {
		return utils.WriteFile(utils.PostgresVersionPath, []byte(version), fsys)
	}
	return nil
}
