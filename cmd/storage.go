package cmd

import (
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/storage/cp"
	"github.com/supabase/cli/internal/storage/ls"
	"github.com/supabase/cli/internal/storage/mv"
	"github.com/supabase/cli/internal/storage/rm"
)

var (
	storageCmd = &cobra.Command{
		GroupID: groupManagementAPI,
		Use:     "storage",
		Short:   "Manage Supabase Storage objects",
	}

	recursive bool

	lsCmd = &cobra.Command{
		Use:     "ls [path]",
		Example: "ls ss:///bucket/docs",
		Short:   "List objects by path prefix",
		Args:    cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			objectPath := ls.STORAGE_SCHEME + ":///"
			if len(args) > 0 {
				objectPath = args[0]
			}
			return ls.Run(cmd.Context(), objectPath, recursive, afero.NewOsFs())
		},
	}

	cpCmd = &cobra.Command{
		Use: "cp <src> <dst>",
		Example: `cp readme.md ss:///bucket
cp -r docs ss:///bucket/docs
cp -r ss:///bucket/docs .
`,
		Short: "Copy objects from src to dst path",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return cp.Run(cmd.Context(), args[0], args[1], recursive, afero.NewOsFs())
		},
	}

	mvCmd = &cobra.Command{
		Use:     "mv <src> <dst>",
		Short:   "Move objects from src to dst path",
		Example: "mv -r ss:///bucket/docs ss:///bucket/www/docs",
		Args:    cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return mv.Run(cmd.Context(), args[0], args[1], recursive, afero.NewOsFs())
		},
	}

	rmCmd = &cobra.Command{
		Use:   "rm <file> ...",
		Short: "Remove objects by file path",
		Example: `rm -r ss:///bucket/docs
rm ss:///bucket/docs/example.md ss:///bucket/readme.md
`,
		Args: cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return rm.Run(cmd.Context(), args, recursive, afero.NewOsFs())
		},
	}
)

func init() {
	lsCmd.Flags().BoolVarP(&recursive, "recursive", "r", false, "Recursively list a directory.")
	storageCmd.AddCommand(lsCmd)
	cpCmd.Flags().BoolVarP(&recursive, "recursive", "r", false, "Recursively copy a directory.")
	storageCmd.AddCommand(cpCmd)
	rmCmd.Flags().BoolVarP(&recursive, "recursive", "r", false, "Recursively move a directory.")
	storageCmd.AddCommand(rmCmd)
	mvCmd.Flags().BoolVarP(&recursive, "recursive", "r", false, "Recursively remove a directory.")
	storageCmd.AddCommand(mvCmd)
	rootCmd.AddCommand(storageCmd)
}
