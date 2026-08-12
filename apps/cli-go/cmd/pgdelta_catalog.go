package cmd

import (
	"fmt"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/db/declarative"
)

// pgdeltaCatalogMode selects which catalog the hidden seam command produces.
var pgdeltaCatalogMode string

// pgdeltaCatalogProjectRef is the resolved linked project ref, forwarded by the
// native-TypeScript seam so the catalog is built from the remote-merged config.
// The declarative group's PersistentPreRunE seeds flags.ProjectRef from it before
// LoadConfig (this command never runs LoadProjectRef, so SUPABASE_PROJECT_ID env
// alone would not trigger the [remotes.<ref>] merge).
var pgdeltaCatalogProjectRef string

// dbDeclarativeCatalogCmd is a hidden seam used by the native-TypeScript
// declarative commands to provision a shadow-database platform baseline (and,
// for migrations/declarative modes, apply migrations / declarative files) and
// export the resulting pg-delta catalog. It prints the catalog file path to
// stdout. Inherits the declarative group's PersistentPreRunE (the
// experimental/pg-delta gate + config load), so callers must pass
// --experimental or enable [experimental.pgdelta].
var dbDeclarativeCatalogCmd = &cobra.Command{
	Use:    "__catalog",
	Hidden: true,
	Short:  "Internal: export a pg-delta catalog for the native declarative commands",
	RunE: func(cmd *cobra.Command, args []string) error {
		ref, err := declarative.ExportModeCatalog(cmd.Context(), pgdeltaCatalogMode, declarativeNoCache, afero.NewOsFs())
		if err != nil {
			return err
		}
		fmt.Println(ref)
		return nil
	},
}

func init() {
	dbDeclarativeCatalogCmd.Flags().StringVar(&pgdeltaCatalogMode, "mode", "", "Catalog mode: baseline, migrations, or declarative.")
	dbDeclarativeCatalogCmd.Flags().StringVar(&pgdeltaCatalogProjectRef, "project-ref", "", "Linked project ref, so the catalog merges the matching [remotes.<ref>] config override.")
	dbDeclarativeCmd.AddCommand(dbDeclarativeCatalogCmd)
}
