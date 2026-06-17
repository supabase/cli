package cmd

import (
	"testing"

	"github.com/spf13/cobra"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils/flags"
)

func TestStoragePersistentPreRun(t *testing.T) {
	t.Run("treats local storage as local development", func(t *testing.T) {
		flags.ProjectRef = "abcdefghijklmnopqrst"
		t.Cleanup(func() {
			flags.ProjectRef = ""
		})

		isManagementAPI, err := runStoragePreRunForTest([]string{"storage", "ls", "--local"})

		require.NoError(t, err)
		assert.False(t, isManagementAPI)
		assert.Empty(t, flags.ProjectRef)
	})

	t.Run("keeps linked storage as management API", func(t *testing.T) {
		flags.ProjectRef = "abcdefghijklmnopqrst"
		t.Cleanup(func() {
			flags.ProjectRef = ""
		})

		isManagementAPI, err := runStoragePreRunForTest([]string{"storage", "ls"})

		require.NoError(t, err)
		assert.True(t, isManagementAPI)
		assert.Equal(t, "abcdefghijklmnopqrst", flags.ProjectRef)
	})
}

func runStoragePreRunForTest(args []string) (bool, error) {
	var isManagementAPI bool
	root := &cobra.Command{
		Use: "supabase",
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			isManagementAPI = IsManagementAPI(cmd)
			return nil
		},
	}
	root.AddGroup(&cobra.Group{ID: groupLocalDev, Title: "Local Development:"})
	root.AddGroup(&cobra.Group{ID: groupManagementAPI, Title: "Management APIs:"})
	storage := &cobra.Command{
		GroupID:           groupManagementAPI,
		Use:               "storage",
		PersistentPreRunE: storageCmd.PersistentPreRunE,
	}
	storage.PersistentFlags().Bool("linked", true, "")
	storage.PersistentFlags().Bool("local", false, "")
	storage.MarkFlagsMutuallyExclusive("linked", "local")
	storage.AddCommand(&cobra.Command{
		Use: "ls",
		Run: func(cmd *cobra.Command, args []string) {},
	})
	root.AddCommand(storage)
	root.SetArgs(args)

	err := root.Execute()
	return isManagementAPI, err
}
