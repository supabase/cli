package push

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/config"
)

func Run(ctx context.Context, ref string, fsys afero.Fs) error {
	if err := flags.LoadConfig(fsys); err != nil {
		return err
	}
	client := config.NewConfigUpdater(*utils.GetSupabase())
	remote, err := utils.Config.GetRemoteByProjectRef(ref)
	if err != nil {
		// Use base config when no remote is declared
		remote.ProjectId = ref
	}
	cost, err := getCostMatrix(ctx, ref)
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Pushing config to project:", remote.ProjectId)
	console := utils.NewConsole()
	keep := func(name string) bool {
		title := fmt.Sprintf("Do you want to push %s config to remote?", name)
		if item, exists := cost[name]; exists {
			title = fmt.Sprintf("Enabling %s will cost you %s. Keep it enabled?", item.Name, item.Price)
		}
		shouldPush, err := console.PromptYesNo(ctx, title, true)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
		return shouldPush
	}
	return client.UpdateRemoteConfig(ctx, remote, keep)
}

type CostItem struct {
	Name  string
	Price string
}

func getCostMatrix(ctx context.Context, projectRef string) (map[string]CostItem, error) {
	resp, err := utils.GetSupabase().V1ListProjectAddonsWithResponse(ctx, projectRef)
	if err != nil {
		return nil, errors.Errorf("failed to list addons: %w", err)
	} else if resp.JSON200 == nil {
		return nil, errors.Errorf("unexpected list addons status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	costMatrix := make(map[string]CostItem, len(resp.JSON200.AvailableAddons))
	for _, addon := range resp.JSON200.AvailableAddons {
		if len(addon.Variants) == 1 {
			costMatrix[string(addon.Type)] = CostItem{
				Name:  addon.Variants[0].Name,
				Price: addon.Variants[0].Price.Description,
			}
		}
	}
	return costMatrix, nil
}
