package sandbox

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/jackc/pgx/v4"
	"github.com/olekukonko/tablewriter"
	"github.com/olekukonko/tablewriter/tw"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/apply"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

const (
	// DefaultServiceTimeout is the maximum time to wait for services to become healthy.
	DefaultServiceTimeout = 120 * time.Second
	// DefaultPostgresPort is the default port in the postgres template config.
	DefaultPostgresPort = 54322
)

// Run starts the sandbox mode with native binaries and process-compose.
// It spawns a background server and exits after services are healthy.
func Run(ctx context.Context, fsys afero.Fs) error {
	// 1. Load config
	if err := flags.LoadConfig(fsys); err != nil {
		return err
	}

	// 2. Create sandbox context with project namespacing
	sandboxCtx, err := NewSandboxContext(utils.Config.ProjectId)
	if err != nil {
		return fmt.Errorf("failed to create sandbox context: %w", err)
	}

	// 3. Check if sandbox is already running
	if sandboxCtx.IsSandboxRunning(fsys) {
		return fmt.Errorf("sandbox is already running. Use 'supabase stop' first")
	}

	// 4. Ensure directories exist
	if err := sandboxCtx.EnsureDirectories(fsys); err != nil {
		return fmt.Errorf("failed to create directories: %w", err)
	}

	// 5. Allocate dynamic ports
	sandboxCtx.Ports, err = AllocatePorts(ctx)
	if err != nil {
		return fmt.Errorf("failed to allocate ports: %w", err)
	}

	// 6. Download service binaries if needed (shared across projects)
	postgresVersion, err := InstallBinaries(ctx, fsys, sandboxCtx.BinDir)
	if err != nil {
		return fmt.Errorf("failed to install binaries: %w", err)
	}

	// 6b. Save postgres version to persistent file (survives stop)
	if err := SavePostgresVersion(fsys, postgresVersion); err != nil {
		return fmt.Errorf("failed to save postgres version: %w", err)
	}

	// 7. Initialize postgres data directory if needed (replaces Docker container setup)
	// Track if this is a first run (pgdata doesn't exist yet) for seed application
	pgVersionFile := filepath.Join(sandboxCtx.PgDataDir(), "PG_VERSION")
	_, statErr := fsys.Stat(pgVersionFile)
	isFirstRun := os.IsNotExist(statErr)

	fmt.Fprintln(os.Stderr, "Starting database...")
	if err := initializePostgresDataDir(ctx, sandboxCtx, fsys, postgresVersion); err != nil {
		return fmt.Errorf("failed to initialize postgres: %w", err)
	}

	// 8. Generate process-compose.yaml configuration
	processComposePath, err := WriteProcessComposeConfig(ctx, sandboxCtx, fsys, postgresVersion)
	if err != nil {
		return fmt.Errorf("failed to write process-compose config: %w", err)
	}

	// 9. Start process-compose and wait for postgres to be healthy
	// This starts all services but only waits for postgres so we can run migrations
	if err := RunProject(processComposePath, sandboxCtx, fsys); err != nil {
		return err
	}

	// 10. Apply migrations and seeds on first run (like Docker mode does in SetupLocalDatabase)
	// Note: Internal migrations are handled by postgres-init in process-compose
	if isFirstRun {
		// Print messages to match Docker output (internal migrations already done by postgres-init)
		fmt.Fprintln(os.Stderr, "Initialising schema...")
		fmt.Fprintln(os.Stderr, "Seeding globals from roles.sql...")

		// Apply user migrations and seeds (which print their own messages)
		if err := applyUserMigrationsAndSeeds(ctx, sandboxCtx, fsys); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to apply migrations/seeds: %v\n", err)
		}
	}

	// 11. Wait for all services to be healthy
	fmt.Fprintln(os.Stderr, "Starting services...")
	fmt.Fprintln(os.Stderr, "Waiting for health checks...")
	if err := WaitForAllServices(sandboxCtx.Ports.ProcessCompose, DefaultServiceTimeout); err != nil {
		return err
	}

	// 12. Print final status and connection info
	fmt.Fprintf(os.Stderr, "Started %s local development setup.\n\n", utils.Aqua("supabase"))
	PrettyPrintSandbox(os.Stdout, sandboxCtx)

	return nil
}

// initializePostgresDataDir initializes the PostgreSQL data directory if needed.
// On first run, it runs initdb and copies config templates from the bundled distribution.
// On subsequent runs, it just updates the port in postgresql.conf if needed.
func initializePostgresDataDir(ctx context.Context, sandboxCtx *SandboxContext, fsys afero.Fs, postgresVersion string) error {
	pgDataDir := sandboxCtx.PgDataDir()
	pgVersionFile := filepath.Join(pgDataDir, "PG_VERSION")

	// Check if already initialized
	if _, err := fsys.Stat(pgVersionFile); err == nil {
		// Already initialized - just update port in postgresql.conf
		return updatePostgresPort(fsys, pgDataDir, sandboxCtx.Ports.Postgres)
	}

	// Create data directory with restricted permissions
	if err := fsys.MkdirAll(pgDataDir, 0700); err != nil {
		return fmt.Errorf("failed to create pgdata directory: %w", err)
	}

	// Create symlink for timezone data (Nix-built postgres has hardcoded paths)
	// This is a workaround for postgres binaries built with --with-system-tzdata pointing to /nix/store
	nixTzdataPath := "/nix/store/fy3qa8s8kzb7a6abzmyidzp1c8axz3s3-tzdata-2025b/share"
	systemZoneinfo := "/var/db/timezone/zoneinfo" // macOS timezone data location
	if runtime.GOOS == "darwin" {
		if _, err := os.Stat(systemZoneinfo); err == nil {
			// Create /nix/store/.../share directory if it doesn't exist
			if err := os.MkdirAll(nixTzdataPath, 0755); err == nil {
				// Create symlink: /nix/store/.../share/zoneinfo -> /var/db/timezone/zoneinfo
				targetPath := filepath.Join(nixTzdataPath, "zoneinfo")
				if _, err := os.Lstat(targetPath); os.IsNotExist(err) {
					_ = os.Symlink(systemZoneinfo, targetPath)
				}
			}
		}
	}

	// Run initdb with supabase_admin as initial superuser (suppress verbose output)
	initdbPath := GetPostgresBinPath(sandboxCtx.BinDir, postgresVersion, "initdb")
	cmd := exec.CommandContext(ctx, initdbPath,
		"-D", pgDataDir,
		"-U", "supabase_admin",
		"--encoding=UTF8",
		"--locale=C",
	)
	setLibraryPath(cmd, GetPostgresLibDir(sandboxCtx.BinDir, postgresVersion))
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("initdb failed: %w", err)
	}

	// Set password using postgres single-user mode (like Docker entrypoint does)
	// This allows scram-sha-256 authentication to work immediately
	postgresPath := GetPostgresBinPath(sandboxCtx.BinDir, postgresVersion, "postgres")
	alterCmd := exec.CommandContext(ctx, postgresPath,
		"--single",
		"-D", pgDataDir,
		"-j", // disable newline as statement terminator
		"postgres",
	)
	setLibraryPath(alterCmd, GetPostgresLibDir(sandboxCtx.BinDir, postgresVersion))
	alterCmd.Stdin = strings.NewReader(fmt.Sprintf("ALTER USER supabase_admin WITH PASSWORD '%s';", utils.Config.Db.Password))
	alterCmd.Stdout = io.Discard
	alterCmd.Stderr = io.Discard

	if err := alterCmd.Run(); err != nil {
		return fmt.Errorf("failed to set superuser password: %w", err)
	}

	// Copy postgresql.conf from bundled template
	postgresDir := GetPostgresDir(sandboxCtx.BinDir, postgresVersion)
	templatePath := filepath.Join(postgresDir, "share", "supabase-cli", "config", "postgresql.conf.template")
	confPath := filepath.Join(pgDataDir, "postgresql.conf")

	templateContent, err := afero.ReadFile(fsys, templatePath)
	if err != nil {
		return fmt.Errorf("failed to read postgresql.conf template: %w", err)
	}

	// Update port and pgsodium/vault getkey paths
	pgsodiumScript := filepath.Join(postgresDir, "share", "supabase-cli", "config", "pgsodium_getkey.sh")
	conf := strings.Replace(string(templateContent), fmt.Sprintf("port = %d", DefaultPostgresPort), fmt.Sprintf("port = %d", sandboxCtx.Ports.Postgres), 1)
	conf += fmt.Sprintf("\npgsodium.getkey_script = '%s'\n", pgsodiumScript)
	conf += fmt.Sprintf("vault.getkey_script = '%s'\n", pgsodiumScript)

	if err := afero.WriteFile(fsys, confPath, []byte(conf), 0600); err != nil {
		return fmt.Errorf("failed to write postgresql.conf: %w", err)
	}

	// Copy pg_hba.conf from bundled template
	// The bundled template uses scram-sha-256 for TCP connections, which works now
	// because we set the password during initdb with --pwfile
	hbaTemplatePath := filepath.Join(postgresDir, "share", "supabase-cli", "config", "pg_hba.conf.template")
	hbaPath := filepath.Join(pgDataDir, "pg_hba.conf")

	hbaContent, err := afero.ReadFile(fsys, hbaTemplatePath)
	if err != nil {
		return fmt.Errorf("failed to read pg_hba.conf template: %w", err)
	}

	if err := afero.WriteFile(fsys, hbaPath, hbaContent, 0600); err != nil {
		return fmt.Errorf("failed to write pg_hba.conf: %w", err)
	}

	return nil
}

// updatePostgresPort updates the port in postgresql.conf for subsequent starts.
func updatePostgresPort(fsys afero.Fs, pgDataDir string, port int) error {
	confPath := filepath.Join(pgDataDir, "postgresql.conf")
	content, err := afero.ReadFile(fsys, confPath)
	if err != nil {
		return fmt.Errorf("failed to read postgresql.conf: %w", err)
	}

	// Replace the port line
	lines := strings.Split(string(content), "\n")
	for i, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "port = ") {
			lines[i] = fmt.Sprintf("port = %d", port)
			break
		}
	}

	return afero.WriteFile(fsys, confPath, []byte(strings.Join(lines, "\n")), 0600)
}

// setLibraryPath sets the appropriate library path environment variable for the command.
func setLibraryPath(cmd *exec.Cmd, libDir string) {
	if cmd.Env == nil {
		cmd.Env = os.Environ()
	}
	switch runtime.GOOS {
	case "darwin":
		cmd.Env = append(cmd.Env, "DYLD_LIBRARY_PATH="+libDir)
	case "linux":
		cmd.Env = append(cmd.Env, "LD_LIBRARY_PATH="+libDir)
	}
}

// PrettyPrintSandbox prints the sandbox status in beautiful tables like Docker mode.
func PrettyPrintSandbox(w io.Writer, sandboxCtx *SandboxContext) {
	ports := sandboxCtx.Ports

	// Build values map
	apiURL := fmt.Sprintf("http://127.0.0.1:%d", ports.API)
	dbURL := fmt.Sprintf("postgresql://%s@127.0.0.1:%d/postgres",
		url.UserPassword("postgres", utils.Config.Db.Password), ports.Postgres)

	groups := []outputGroup{
		{
			Name: "🌐 APIs",
			Items: []outputItem{
				{Label: "API URL", Value: apiURL, Type: outputLink},
				{Label: "REST", Value: fmt.Sprintf("%s/rest/v1/", apiURL), Type: outputLink},
				{Label: "Auth", Value: fmt.Sprintf("%s/auth/v1/", apiURL), Type: outputLink},
			},
		},
		{
			Name: "⛁ Database",
			Items: []outputItem{
				{Label: "URL", Value: dbURL, Type: outputLink},
			},
		},
		{
			Name: "🔑 Authentication Keys",
			Items: []outputItem{
				{Label: "Publishable", Value: utils.Config.Auth.PublishableKey.Value, Type: outputKey},
				{Label: "Secret", Value: utils.Config.Auth.SecretKey.Value, Type: outputKey},
			},
		},
	}

	for _, group := range groups {
		if err := group.printTable(w); err != nil {
			fmt.Fprintln(utils.GetDebugLogger(), err)
		} else {
			fmt.Fprintln(w)
		}
	}
}

type outputType string

const (
	outputText outputType = "text"
	outputLink outputType = "link"
	outputKey  outputType = "key"
)

type outputItem struct {
	Label string
	Value string
	Type  outputType
}

type outputGroup struct {
	Name  string
	Items []outputItem
}

func (g *outputGroup) printTable(w io.Writer) error {
	table := tablewriter.NewTable(w,
		// Rounded corners
		tablewriter.WithSymbols(tw.NewSymbols(tw.StyleRounded)),

		// Table content formatting
		tablewriter.WithConfig(tablewriter.Config{
			Header: tw.CellConfig{
				Formatting: tw.CellFormatting{
					AutoFormat: tw.Off,
					MergeMode:  tw.MergeHorizontal,
				},
				Alignment: tw.CellAlignment{
					Global: tw.AlignLeft,
				},
				Filter: tw.CellFilter{
					Global: func(s []string) []string {
						for i := range s {
							s[i] = utils.Bold(s[i])
						}
						return s
					},
				},
			},
			Row: tw.CellConfig{
				Alignment: tw.CellAlignment{
					Global: tw.AlignLeft,
				},
				ColMaxWidths: tw.CellWidth{
					PerColumn: map[int]int{0: 16},
				},
				Filter: tw.CellFilter{
					PerColumn: []func(string) string{
						func(s string) string {
							return utils.Green(s)
						},
					},
				},
			},
			Behavior: tw.Behavior{
				Compact: tw.Compact{
					Merge: tw.On,
				},
			},
		}),

		// Set title as header (merged across all columns)
		tablewriter.WithHeader([]string{g.Name, g.Name}),
	)

	// Add data rows with values colored based on type
	shouldRender := false
	for _, row := range g.Items {
		if row.Value == "" {
			continue
		}
		value := row.Value
		switch row.Type {
		case outputLink:
			value = utils.Aqua(row.Value)
		case outputKey:
			value = utils.Yellow(row.Value)
		}
		if err := table.Append(row.Label, value); err != nil {
			return fmt.Errorf("failed to append row: %w", err)
		}
		shouldRender = true
	}

	// Ensure at least one item in the group is non-empty
	if shouldRender {
		if err := table.Render(); err != nil {
			return fmt.Errorf("failed to render table: %w", err)
		}
	}

	return nil
}

// applyUserMigrationsAndSeeds connects to postgres and applies user migrations and seed files on first run.
// This mirrors the behavior in Docker mode where SetupLocalDatabase calls apply.MigrateAndSeed.
// Note: Supabase internal migrations are already handled by postgres-init in process-compose.
func applyUserMigrationsAndSeeds(ctx context.Context, sandboxCtx *SandboxContext, fsys afero.Fs) error {
	// Connect to postgres using sandbox port via connection URL
	connURL := fmt.Sprintf("postgresql://supabase_admin:%s@127.0.0.1:%d/postgres",
		utils.Config.Db.Password, sandboxCtx.Ports.Postgres)

	conn, err := pgx.Connect(ctx, connURL)
	if err != nil {
		return fmt.Errorf("failed to connect to postgres: %w", err)
	}
	defer conn.Close(ctx)

	// Apply user migrations and seeds using the same logic as Docker mode
	return apply.MigrateAndSeed(ctx, "", conn, fsys)
}
