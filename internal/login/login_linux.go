//go:build !windows && !darwin

package login

import (
	"context"
	"os/exec"
)

func RunOpenCmd(ctx context.Context, input string) error {
	if err := exec.CommandContext(ctx, "xdg-open", input).Run(); err != nil {
		if err := exec.CommandContext(ctx, "x-www-browser", input).Run(); err != nil {
			if err := exec.CommandContext(ctx, "wslview", input).Run(); err != nil {
				return exec.CommandContext(ctx, "sensible-browser", input).Run()
			}
		}
	}
	return nil
}
