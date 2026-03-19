package cmd

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/db/declarative"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/migration/new"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/migration"
	"golang.org/x/term"
)

const defaultDeclarativeSyncName = "declarative_sync"

var (
	declarativeNoCache   bool
	declarativeOverwrite bool
	declarativeLocal     bool
	declarativeReset     bool
	declarativeApply     bool
	declarativeFile      string
	declarativeName      string

	// dbSchemaCmd groups schema-related subcommands under `supabase db schema`.
	dbSchemaCmd = &cobra.Command{
		Use:   "schema",
		Short: "Manage database schema",
	}

	// dbDeclarativeCmd introduces a dedicated command group for declarative workflows.
	dbDeclarativeCmd = &cobra.Command{
		Use:   "declarative",
		Short: "Manage declarative database schemas",
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			if err := flags.LoadConfig(afero.NewOsFs()); err != nil {
				return err
			}
			if viper.GetBool("EXPERIMENTAL") || utils.IsPgDeltaEnabled() {
				return nil
			}
			utils.CmdSuggestion = fmt.Sprintf("Either pass %s or add %s with %s to %s",
				utils.Aqua("--experimental"),
				utils.Aqua("[experimental.pgdelta]"),
				utils.Aqua("enabled = true"),
				utils.Bold(utils.ConfigPath))
			return errors.New("declarative commands require --experimental flag or pg-delta enabled in config")
		},
	}

	// dbDeclarativeSyncCmd generates a new migration from declarative schema.
	dbDeclarativeSyncCmd = &cobra.Command{
		Use:   "sync",
		Short: "Generate a new migration from declarative schema",
		RunE:  runDeclarativeSync,
	}

	// dbDeclarativeGenerateCmd generates declarative files directly from a live
	// database target. This is the entrypoint for bootstrapping declarative mode.
	dbDeclarativeGenerateCmd = &cobra.Command{
		Use:   "generate",
		Short: "Generate declarative schema from a database",
		RunE:  runDeclarativeGenerate,
		PostRun: func(cmd *cobra.Command, args []string) {
			fmt.Println("Finished " + utils.Aqua("supabase db schema declarative generate") + ".")
		},
	}
)

func resolveDeclarativeMigrationName(name, file string) string {
	if len(name) > 0 {
		return name
	}
	return file
}

func ensureLocalDatabaseStarted(ctx context.Context, local bool, isRunning func() error, startDatabase func(context.Context) error) error {
	if !local {
		return nil
	}
	if err := isRunning(); err != nil {
		if errors.Is(err, utils.ErrNotRunning) {
			return startDatabase(ctx)
		}
		return err
	}
	return nil
}

// hasExplicitTargetFlag returns true if the user explicitly set --local, --linked, or --db-url.
func hasExplicitTargetFlag(cmd *cobra.Command) bool {
	return cmd.Flags().Changed("local") || cmd.Flags().Changed("linked") || cmd.Flags().Changed("db-url")
}

// isTTY returns true if stdin is a terminal.
func isTTY() bool {
	return term.IsTerminal(int(os.Stdin.Fd())) //nolint:gosec // G115: stdin fd always fits in int
}

// hasDeclarativeFiles checks if the declarative schema directory exists and contains files.
func hasDeclarativeFiles(fsys afero.Fs) bool {
	declarativeDir := utils.GetDeclarativeDir()
	exists, err := afero.DirExists(fsys, declarativeDir)
	if err != nil || !exists {
		return false
	}
	files, err := afero.ReadDir(fsys, declarativeDir)
	if err != nil {
		return false
	}
	return len(files) > 0
}

// hasMigrationFiles checks if the migrations directory contains migration files.
func hasMigrationFiles(fsys afero.Fs) bool {
	migrations, err := migration.ListLocalMigrations(utils.MigrationsDir, afero.NewIOFS(fsys))
	if err != nil {
		return false
	}
	return len(migrations) > 0
}

// configureLocalDbConfig sets flags.DbConfig for local database connection.
func configureLocalDbConfig() {
	flags.DbConfig = pgconn.Config{
		Host:     utils.Config.Hostname,
		Port:     utils.Config.Db.Port,
		User:     "postgres",
		Password: utils.Config.Db.Password,
		Database: "postgres",
	}
}

// runDeclarativeGenerate implements the smart interactive generate flow.
func runDeclarativeGenerate(cmd *cobra.Command, args []string) error {
	ctx := cmd.Context()
	fsys := afero.NewOsFs()

	// When an explicit target flag is provided, use the direct path.
	if hasExplicitTargetFlag(cmd) {
		if err := ensureLocalDatabaseStarted(ctx, declarativeLocal, utils.AssertSupabaseDbIsRunning, func(ctx context.Context) error {
			return start.Run(ctx, "", fsys)
		}); err != nil {
			return err
		}
		return declarative.Generate(ctx, schema, flags.DbConfig, declarativeOverwrite, declarativeNoCache, fsys)
	}

	// Smart mode: no explicit target flag
	if !isTTY() && !viper.GetBool("YES") {
		return errors.New("in non-interactive mode, specify a target: --local, --linked, or --db-url")
	}

	console := utils.NewConsole()

	// Check if declarative dir already has files
	if hasDeclarativeFiles(fsys) && !declarativeOverwrite {
		msg := fmt.Sprintf("Declarative schema already exists at %s. Regenerate from database? This will overwrite existing files.", utils.Bold(utils.GetDeclarativeDir()))
		ok, err := console.PromptYesNo(ctx, msg, false)
		if err != nil {
			return err
		}
		if !ok {
			fmt.Fprintln(os.Stderr, "Skipped generating declarative schema.")
			return nil
		}
	}

	// Check for migrations and offer choices
	if hasMigrationFiles(fsys) {
		// Try to resolve linked project ref for the prompt
		var linkedRef string
		if err := flags.LoadProjectRef(fsys); err == nil {
			linkedRef = flags.ProjectRef
		}

		choices := []utils.PromptItem{
			{Summary: "Local database", Details: "generate from local Postgres", Index: 0},
		}
		if len(linkedRef) > 0 {
			choices = append(choices, utils.PromptItem{
				Summary: "Linked project",
				Details: fmt.Sprintf("generate from remote linked project (%s)", linkedRef),
				Index:   1,
			})
		}
		choices = append(choices, utils.PromptItem{
			Summary: "Custom database URL",
			Details: "enter a connection string",
			Index:   2,
		})

		choice, err := utils.PromptChoice(ctx, "Generate declarative schema from:", choices)
		if err != nil {
			return err
		}

		switch choice.Index {
		case 0: // Local database
			if err := ensureLocalDatabaseStarted(ctx, true, utils.AssertSupabaseDbIsRunning, func(ctx context.Context) error {
				return start.Run(ctx, "", fsys)
			}); err != nil {
				return err
			}
			// Prompt to reset local DB first
			shouldReset := declarativeReset
			if !shouldReset {
				shouldReset, err = console.PromptYesNo(ctx, "Reset local database to match migrations first? (local data will be lost)", false)
				if err != nil {
					return err
				}
			}
			if shouldReset {
				configureLocalDbConfig()
				if err := reset.Run(ctx, "", 0, flags.DbConfig, fsys); err != nil {
					return err
				}
			}
			configureLocalDbConfig()
		case 1: // Linked project
			var err error
			flags.DbConfig, err = flags.NewDbConfigWithPassword(ctx, flags.ProjectRef)
			if err != nil {
				return err
			}
		case 2: // Custom database URL
			dbURL, err := console.PromptText(ctx, "Enter database URL: ")
			if err != nil {
				return err
			}
			if len(strings.TrimSpace(dbURL)) == 0 {
				return errors.New("database URL cannot be empty")
			}
			config, err := pgconn.ParseConfig(dbURL)
			if err != nil {
				return fmt.Errorf("failed to parse connection string: %w", err)
			}
			flags.DbConfig = *config
		}
	} else {
		// No migrations — generate from local DB
		if err := ensureLocalDatabaseStarted(ctx, true, utils.AssertSupabaseDbIsRunning, func(ctx context.Context) error {
			return start.Run(ctx, "", fsys)
		}); err != nil {
			return err
		}
		configureLocalDbConfig()
	}

	return declarative.Generate(ctx, schema, flags.DbConfig, true, declarativeNoCache, fsys)
}

// runDeclarativeSync implements the smart interactive sync flow.
func runDeclarativeSync(cmd *cobra.Command, args []string) error {
	ctx := cmd.Context()
	fsys := afero.NewOsFs()
	console := utils.NewConsole()

	// Step 1: Check if declarative dir has files
	if !hasDeclarativeFiles(fsys) {
		if !isTTY() && !viper.GetBool("YES") {
			return fmt.Errorf("no declarative schema found. Run %s first", utils.Aqua("supabase db schema declarative generate"))
		}
		ok, err := console.PromptYesNo(ctx, "No declarative schema found. Generate a new one ?", true)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("no declarative schema found. Run %s first", utils.Aqua("supabase db schema declarative generate"))
		}
		// Run smart generate flow
		if err := runDeclarativeGenerate(cmd, args); err != nil {
			return err
		}
		// Verify declarative files were actually generated
		if !hasDeclarativeFiles(fsys) {
			return errors.New("declarative schema generation did not produce any files")
		}
	}

	// Step 2: Generate migration diff
	result, err := declarative.DiffDeclarativeToMigrations(ctx, schema, declarativeNoCache, fsys)
	if err != nil {
		// Save debug bundle on error
		bundle := declarative.DebugBundle{
			Error:      err,
			Migrations: declarative.CollectMigrationsList(fsys),
		}
		if debugDir, saveErr := declarative.SaveDebugBundle(bundle, fsys); saveErr == nil {
			declarative.PrintDebugBundleMessage(debugDir)
		}
		return err
	}

	// Step 3: Check for empty diff
	if len(strings.TrimSpace(result.DiffSQL)) < 2 {
		fmt.Fprintln(os.Stderr, "No schema changes found")
		return nil
	}

	// Step 4: Resolve migration name
	migrationName := resolveDeclarativeMigrationName(declarativeName, declarativeFile)

	// Prompt for name if not set via flags and TTY is available
	if len(declarativeName) == 0 && isTTY() && !viper.GetBool("YES") {
		input, err := console.PromptText(ctx, fmt.Sprintf("Enter a name for this migration (press Enter to keep '%s'): ", migrationName))
		if err != nil {
			return err
		}
		if len(strings.TrimSpace(input)) > 0 {
			migrationName = strings.TrimSpace(input)
		}
	}

	// Step 5: Save migration file
	timestamp := utils.GetCurrentTimestamp()
	path := new.GetMigrationPath(timestamp, migrationName)
	if err := utils.WriteFile(path, []byte(result.DiffSQL), fsys); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Created new migration at "+utils.Bold(path))

	// Show drop warnings
	if len(result.DropWarnings) > 0 {
		fmt.Fprintln(os.Stderr, utils.Yellow("Found drop statements in schema diff. Please double check if these are expected:"))
		fmt.Fprintln(os.Stderr, utils.Yellow(strings.Join(result.DropWarnings, "\n")))
	}

	// Step 6: Prompt to apply migration to local DB
	shouldApply := declarativeApply
	if !shouldApply && isTTY() && !viper.GetBool("YES") {
		shouldApply, err = console.PromptYesNo(ctx, "Apply this migration to local database?", true)
		if err != nil {
			return err
		}
	} else if viper.GetBool("YES") {
		shouldApply = true
	}

	if shouldApply {
		if applyErr := applyMigrationToLocal(ctx, path, fsys); applyErr != nil {
			fmt.Fprintln(os.Stderr, utils.Red("Migration failed to apply: "+applyErr.Error()))

			// Save debug bundle with apply error context
			ts := time.Now().UTC().Format("20060102-150405")
			debugDir := saveApplyDebugBundle(ts+"-apply-error", result, applyErr, fsys)

			// In interactive mode, offer to reset and reapply
			if isTTY() && !viper.GetBool("YES") {
				shouldReset, promptErr := console.PromptYesNo(ctx, "Would you like to reset the local database and reapply all migrations? (local data will be lost)", false)
				if promptErr != nil {
					return promptErr
				}
				if shouldReset {
					configureLocalDbConfig()
					if resetErr := reset.Run(ctx, "", 0, flags.DbConfig, fsys); resetErr != nil {
						fmt.Fprintln(os.Stderr, utils.Red("Database reset also failed: "+resetErr.Error()))
						resetDebugDir := saveApplyDebugBundle(ts+"-after-reset", result, resetErr, fsys)
						if len(debugDir) > 0 {
							fmt.Fprintln(os.Stderr, "\nDebug information saved to "+utils.Bold(debugDir))
						}
						if len(resetDebugDir) > 0 {
							fmt.Fprintln(os.Stderr, "Debug information saved to "+utils.Bold(resetDebugDir))
						}
						declarative.PrintDebugBundleMessage("")
						return resetErr
					}
					fmt.Fprintln(os.Stderr, "Database reset and all migrations applied successfully.")
					return nil
				}
			}

			// Non-interactive or user declined reset
			if len(debugDir) > 0 {
				declarative.PrintDebugBundleMessage(debugDir)
			}
			return applyErr
		}
		fmt.Fprintln(os.Stderr, "Migration applied successfully.")
	}

	return nil
}

// saveApplyDebugBundle saves a debug bundle for apply errors and returns the debug directory path.
func saveApplyDebugBundle(id string, result *declarative.SyncResult, applyErr error, fsys afero.Fs) string {
	bundle := declarative.DebugBundle{
		ID:           id,
		SourceRef:    result.SourceRef,
		TargetRef:    result.TargetRef,
		MigrationSQL: result.DiffSQL,
		Error:        applyErr,
		Migrations:   declarative.CollectMigrationsList(fsys),
	}
	debugDir, saveErr := declarative.SaveDebugBundle(bundle, fsys)
	if saveErr != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to save debug artifacts: %v\n", saveErr)
		return ""
	}
	return debugDir
}

// applyMigrationToLocal connects to the local database and applies a single migration.
func applyMigrationToLocal(ctx context.Context, migrationPath string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	config := pgconn.Config{
		Host:     utils.Config.Hostname,
		Port:     utils.Config.Db.Port,
		User:     "postgres",
		Password: utils.Config.Db.Password,
		Database: "postgres",
	}
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	return migration.ApplyMigrations(ctx, []string{migrationPath}, conn, afero.NewIOFS(fsys))
}

func init() {
	// no-cache allows bypassing catalog snapshots when users need a fresh view of
	// database state, even if cached artifacts are available.
	declarativeFlags := dbDeclarativeCmd.PersistentFlags()
	declarativeFlags.BoolVar(&declarativeNoCache, "no-cache", false, "Disable catalog cache and force fresh shadow database setup.")

	syncFlags := dbDeclarativeSyncCmd.Flags()
	syncFlags.StringSliceVarP(&schema, "schema", "s", []string{}, "Comma separated list of schema to include.")
	syncFlags.StringVarP(&declarativeFile, "file", "f", defaultDeclarativeSyncName, "Saves schema diff to a new migration file.")
	syncFlags.StringVar(&declarativeName, "name", "", "Name for the generated migration file.")
	syncFlags.BoolVar(&declarativeApply, "apply", false, "Apply the generated migration to the local database without prompting.")

	generateFlags := dbDeclarativeGenerateCmd.Flags()
	generateFlags.BoolVar(&declarativeOverwrite, "overwrite", false, "Overwrite declarative schema files without confirmation.")
	generateFlags.BoolVar(&declarativeReset, "reset", false, "Reset local database before generating (local data will be lost).")
	generateFlags.StringSliceVarP(&schema, "schema", "s", []string{}, "Comma separated list of schema to include.")
	generateFlags.String("db-url", "", "Generates declarative schema from the database specified by the connection string (must be percent-encoded).")
	generateFlags.Bool("linked", false, "Generates declarative schema from the linked project.")
	generateFlags.BoolVar(&declarativeLocal, "local", false, "Generates declarative schema from the local database.")
	dbDeclarativeGenerateCmd.MarkFlagsMutuallyExclusive("db-url", "linked", "local")
	generateFlags.StringVarP(&dbPassword, "password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", generateFlags.Lookup("password")))

	dbDeclarativeCmd.AddCommand(dbDeclarativeSyncCmd)
	dbDeclarativeCmd.AddCommand(dbDeclarativeGenerateCmd)
	dbSchemaCmd.AddCommand(dbDeclarativeCmd)
	dbCmd.AddCommand(dbSchemaCmd)
}
