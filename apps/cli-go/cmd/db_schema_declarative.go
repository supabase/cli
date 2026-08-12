package cmd

import (
	"errors"
	"fmt"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/config"
)

// Only the hidden `db schema declarative __catalog` seam (cmd/pgdelta_catalog.go)
// survives CLI-1970's trim of this file. The visible sync/generate commands are
// native TypeScript and were deleted here (last present at commit 7b469f5b3),
// but the native implementations still spawn the seam to provision the shadow
// database and export pg-delta catalogs, so its parent group — including the
// experimental/pg-delta gate and the persistent --no-cache flag the seam argv
// carries — must stay.

var (
	declarativeNoCache bool

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
			// The hidden __catalog seam forwards the resolved linked ref via
			// --project-ref so the catalog is built from the remote-merged config.
			// Seed flags.ProjectRef before LoadConfig (which keys the [remotes.<ref>]
			// merge off Config.ProjectId = flags.ProjectRef); this command never runs
			// LoadProjectRef, so SUPABASE_PROJECT_ID env alone would not merge.
			if len(pgdeltaCatalogProjectRef) > 0 {
				flags.ProjectRef = pgdeltaCatalogProjectRef
			}
			// LoadConfig applies profile-specific overrides keyed off
			// utils.CurrentProfile (internal/utils/flags/config_path.go), which is
			// only populated by LoadProfile. The root pre-run (cmd/root.go:101) runs
			// AFTER this block — it is chained at the bottom of this function — so
			// CurrentProfile would still be its zero value when LoadConfig runs here.
			// Load the profile first to match the real in-process path, where
			// LoadConfig is only ever reached from a RunE after the root pre-run has
			// already set the profile (e.g. internal/db/diff/explicit.go). Without
			// this, a --profile forwarded to the hidden __catalog seam is ignored
			// when the catalog config is built.
			if err := utils.LoadProfile(cmd.Context(), afero.NewOsFs()); err != nil {
				return err
			}
			if err := flags.LoadConfig(afero.NewOsFs()); err != nil {
				return err
			}
			// If the user has passed the --experimental flag and pg-delta is not enabled, enable it
			// so in the rest of the code we can know that we're running pg-delta logic.
			if viper.GetBool("EXPERIMENTAL") && !utils.IsPgDeltaEnabled() {
				if utils.Config.Experimental.PgDelta == nil {
					utils.Config.Experimental.PgDelta = &config.PgDeltaConfig{Enabled: true}
				} else {
					// We preserve the version set into `.temp/pgdelta-version` by just enabling pg-delta.
					utils.Config.Experimental.PgDelta.Enabled = true
				}
			}
			if !utils.IsPgDeltaEnabled() {
				utils.CmdSuggestion = fmt.Sprintf("Either pass %s or add %s with %s to %s",
					utils.Aqua("--experimental"),
					utils.Aqua("[experimental.pgdelta]"),
					utils.Aqua("enabled = true"),
					utils.Bold(utils.ConfigPath))
				return errors.New("declarative commands require --experimental flag or pg-delta enabled in config")
			}
			// If the config.toml has [experimental.pgdelta] enabled = true, set the EXPERIMENTAL flag to true
			// so the follow-up PersistentPreRunE can run the pg-delta logic.
			if utils.Config.Experimental.PgDelta.Enabled {
				viper.Set("EXPERIMENTAL", true)
			}
			return cmd.Root().PersistentPreRunE(cmd, args)
		},
	}
)

func init() {
	// no-cache allows bypassing catalog snapshots when users need a fresh view of
	// database state, even if cached artifacts are available.
	declarativeFlags := dbDeclarativeCmd.PersistentFlags()
	declarativeFlags.BoolVar(&declarativeNoCache, "no-cache", false, "Disable catalog cache and force fresh shadow database setup.")

	dbSchemaCmd.AddCommand(dbDeclarativeCmd)
	dbCmd.AddCommand(dbSchemaCmd)
}
