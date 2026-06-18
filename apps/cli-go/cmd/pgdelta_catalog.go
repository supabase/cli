package cmd

import (
	"fmt"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/db/declarative"
)

// pgdeltaCatalogMode selects which catalog the hidden seam command produces.
var pgdeltaCatalogMode string

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
	dbDeclarativeCmd.AddCommand(dbDeclarativeCatalogCmd)
}
