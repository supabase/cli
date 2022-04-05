package info

import (
	"context"
	"fmt"

	"github.com/supabase/cli/internal/utils"
)

var ctx = context.Background()

func Run() error {
	// Sanity checks.
	if err := utils.AssertDockerIsRunning(); err != nil {
		return err
	}
	if err := utils.LoadConfig(); err != nil {
		return err
	}

	fmt.Println(utils.GetProjectInfo())

	return nil
}
