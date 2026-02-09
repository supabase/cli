package sandbox

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
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

	// 7. Track if this is a first run (pgdata doesn't exist yet) for seed application
	pgVersionFile := filepath.Join(sandboxCtx.PgDataDir(), "PG_VERSION")
	_, statErr := fsys.Stat(pgVersionFile)
	isFirstRun := os.IsNotExist(statErr)

	fmt.Fprintln(os.Stderr, "Starting database...")

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
