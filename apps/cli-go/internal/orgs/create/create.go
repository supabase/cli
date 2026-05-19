package create

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/orgs/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

type createOrganizationRequest struct {
	Name      string `json:"name"`
	HeardFrom string `json:"heard_from,omitempty"`
	Building  string `json:"building,omitempty"`
}

var newConsole = utils.NewConsole

func Run(ctx context.Context, name string) error {
	body, err := buildCreateOrganizationRequest(ctx, name)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return errors.Errorf("failed to encode organization request: %w", err)
	}
	if utils.OutputFormat.Value == utils.OutputPretty {
		fmt.Fprintln(os.Stderr, "Creating organization...")
	}
	resp, err := utils.GetSupabase().V1CreateAnOrganizationWithBodyWithResponse(ctx, "application/json", bytes.NewReader(payload))
	if err != nil {
		return errors.Errorf("failed to create organization: %w", err)
	} else if resp.JSON201 == nil {
		return errors.Errorf("unexpected create organization status %d: %s", resp.StatusCode(), string(resp.Body))
	}

	fmt.Println("Created organization:", resp.JSON201.Id)
	if utils.OutputFormat.Value == utils.OutputPretty {
		table := list.ToMarkdown([]api.OrganizationResponseV1{*resp.JSON201})
		return utils.RenderTable(table)
	}
	return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, *resp.JSON201)
}

func buildCreateOrganizationRequest(ctx context.Context, name string) (createOrganizationRequest, error) {
	body := createOrganizationRequest{Name: name}
	console := newConsole()
	if utils.OutputFormat.Value != utils.OutputPretty || !console.IsTTY {
		return body, nil
	}

	heardFrom, err := console.PromptText(ctx, "Where did you hear about us? (optional) ")
	if err != nil {
		return body, err
	}
	body.HeardFrom = strings.TrimSpace(heardFrom)

	building, err := console.PromptText(ctx, "What are you building? (optional) ")
	if err != nil {
		return body, err
	}
	body.Building = strings.TrimSpace(building)

	return body, nil
}
