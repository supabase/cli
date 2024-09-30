package unpause

import (
	"context"
	"fmt"
	"net/http"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
)

func PreRun(ctx context.Context, ref string) error {
	if err := utils.AssertProjectRefIsValid(ref); err != nil {
		return err
	}
	title := fmt.Sprintf("Do you want to unpause project %s?", utils.Aqua(ref))
	if shouldUnpause, err := utils.NewConsole().PromptYesNo(ctx, title, false); err != nil {
		return err
	} else if !shouldUnpause {
		return errors.New(context.Canceled)
	}
	return nil
}

func Run(ctx context.Context, ref string) error {
	resp, err := utils.GetSupabase().V1UnpauseAProjectWithResponse(ctx, ref)
	if err != nil {
		return errors.Errorf("failed to unpause project: %w", err)
	}

	switch resp.StatusCode() {
	case http.StatusNotFound:
		return errors.New("Project does not exist:" + utils.Aqua(ref))
	case http.StatusCreated:
		break
	default:
		return errors.Errorf("Failed to unpause project %s: %s", utils.Aqua(ref), string(resp.Body))
	}

	fmt.Println("Unpausing project: " + utils.Aqua(ref) + " it should be ready in a few minutes.\nRun: " + utils.Bold("supabase projects list") + " to see your projects status.")
	return nil
}
