package create

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/orgs/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/fetcher"
)

type createOrganizationInput struct {
	Name      string
	HeardFrom string
	Building  string
}

type onboardingSurveyRequest struct {
	Slug      string `json:"slug"`
	HeardFrom string `json:"heard_from,omitempty"`
	Building  string `json:"building,omitempty"`
}

var newConsole = utils.NewConsole
var submitSurvey = submitOnboardingSurvey

func Run(ctx context.Context, name string) error {
	input, err := buildCreateOrganizationInput(ctx, name)
	if err != nil {
		return err
	}
	if utils.OutputFormat.Value == utils.OutputPretty {
		fmt.Fprintln(os.Stderr, "Creating organization...")
	}
	resp, err := utils.GetSupabase().V1CreateAnOrganizationWithResponse(ctx, api.V1CreateAnOrganizationJSONRequestBody{
		Name: input.Name,
	})
	if err != nil {
		return errors.Errorf("failed to create organization: %w", err)
	} else if resp.JSON201 == nil {
		return errors.Errorf("unexpected create organization status %d: %s", resp.StatusCode(), string(resp.Body))
	}

	survey := onboardingSurveyRequest{
		Slug:      organizationSlug(*resp.JSON201),
		HeardFrom: input.HeardFrom,
		Building:  input.Building,
	}
	if err := submitSurvey(ctx, survey); err != nil && utils.OutputFormat.Value == utils.OutputPretty {
		fmt.Fprintln(os.Stderr, "WARN: failed to submit organization survey:", err)
	}

	fmt.Println("Created organization:", resp.JSON201.Id)
	if utils.OutputFormat.Value == utils.OutputPretty {
		table := list.ToMarkdown([]api.OrganizationResponseV1{*resp.JSON201})
		return utils.RenderTable(table)
	}
	return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, *resp.JSON201)
}

func buildCreateOrganizationInput(ctx context.Context, name string) (createOrganizationInput, error) {
	body := createOrganizationInput{Name: name}
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

func organizationSlug(org api.OrganizationResponseV1) string {
	if org.Slug != "" {
		return org.Slug
	}
	return org.Id
}

func submitOnboardingSurvey(ctx context.Context, body onboardingSurveyRequest) error {
	if body.HeardFrom == "" && body.Building == "" {
		return nil
	}
	token, err := utils.LoadAccessTokenFS(afero.NewOsFs())
	if err != nil {
		return err
	}
	client := fetcher.NewFetcher(
		utils.GetSupabaseAPIHost(),
		fetcher.WithBearerToken(token),
		fetcher.WithUserAgent("SupabaseCLI/"+utils.Version),
		fetcher.WithExpectedStatus(http.StatusNoContent),
	)
	resp, err := client.Send(ctx, http.MethodPost, "/platform/organizations/onboarding-survey", body)
	if err != nil {
		return err
	}
	return resp.Body.Close()
}
