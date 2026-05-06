package cmd

import (
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/storage/client"
	"github.com/supabase/cli/internal/storage/cp"
	"github.com/supabase/cli/internal/storage/ls"
	"github.com/supabase/cli/internal/storage/mv"
	"github.com/supabase/cli/internal/storage/rm"
	"github.com/supabase/cli/pkg/storage"
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
			objectPath := client.STORAGE_SCHEME + ":///"
			if len(args) > 0 {
				objectPath = args[0]
			}
			return ls.Run(cmd.Context(), objectPath, recursive, afero.NewOsFs())
		},
	}

	options storage.FileOptions
	maxJobs uint

	cpCmd = &cobra.Command{
		Use: "cp <src> <dst>",
		Example: `cp readme.md ss:///bucket/readme.md
cp -r docs ss:///bucket/docs
cp -r ss:///bucket/docs .
`,
		Short: "Copy objects from src to dst path",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			opts := func(fo *storage.FileOptions) {
				fo.CacheControl = options.CacheControl
				fo.ContentType = options.ContentType
			}
			return cp.Run(cmd.Context(), args[0], args[1], recursive, maxJobs, afero.NewOsFs(), opts)
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
		RunE: func(cmd *cobra.Command, args []string) error {
			return rm.Run(cmd.Context(), args, recursive, afero.NewOsFs())
		},
	}
)

func init() {
	storageFlags := storageCmd.PersistentFlags()
	storageFlags.Bool("linked", true, "Connects to Storage API of the linked project.")
	storageFlags.Bool("local", false, "Connects to Storage API of the local database.")
	storageCmd.MarkFlagsMutuallyExclusive("linked", "local")
	lsCmd.Flags().BoolVarP(&recursive, "recursive", "r", false, "Recursively list a directory.")
	storageCmd.AddCommand(lsCmd)
	cpFlags := cpCmd.Flags()
	cpFlags.BoolVarP(&recursive, "recursive", "r", false, "Recursively copy a directory.")
	cpFlags.StringVar(&options.CacheControl, "cache-control", "max-age=3600", "Custom Cache-Control header for HTTP upload.")
	cpFlags.StringVar(&options.ContentType, "content-type", "", "Custom Content-Type header for HTTP upload.")
	cpFlags.Lookup("content-type").DefValue = "auto-detect"
	cpFlags.UintVarP(&maxJobs, "jobs", "j", 1, "Maximum number of parallel jobs.")
	storageCmd.AddCommand(cpCmd)
	rmCmd.Flags().BoolVarP(&recursive, "recursive", "r", false, "Recursively remove a directory.")
	storageCmd.AddCommand(rmCmd)
	mvCmd.Flags().BoolVarP(&recursive, "recursive", "r", false, "Recursively move a directory.")
	storageCmd.AddCommand(mvCmd)
	rootCmd.AddCommand(storageCmd)
}
