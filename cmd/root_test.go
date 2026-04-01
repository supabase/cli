package cmd

import (
	"testing"

	"github.com/spf13/cobra"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCommandAnalyticsContext(t *testing.T) {
	root := &cobra.Command{Use: "supabase"}
	var projectRef string
	var linked bool
	child := &cobra.Command{
		Use: "link",
		RunE: func(cmd *cobra.Command, args []string) error {
			return nil
		},
	}
	root.PersistentFlags().Bool("debug", false, "")
	child.Flags().StringVar(&projectRef, "project-ref", "", "")
	child.Flags().BoolVar(&linked, "linked", false, "")
	child.Flags().AddFlag(root.PersistentFlags().Lookup("debug"))
	root.AddCommand(child)

	require.NoError(t, root.PersistentFlags().Set("debug", "true"))
	require.NoError(t, child.Flags().Set("project-ref", "proj_123"))

	ctx := commandAnalyticsContext(child)

	assert.Equal(t, "link", ctx.Command)
	assert.Equal(t, []string{"debug", "project-ref"}, ctx.FlagsUsed)
	assert.Equal(t, map[string]any{}, ctx.FlagValues)
	assert.NotEmpty(t, ctx.RunID)
}

func TestCommandName(t *testing.T) {
	root := &cobra.Command{Use: "supabase"}
	parent := &cobra.Command{Use: "db"}
	child := &cobra.Command{Use: "push"}
	root.AddCommand(parent)
	parent.AddCommand(child)

	assert.Equal(t, "db push", commandName(child))
	assert.Equal(t, "supabase", commandName(root))
}
