package bearerjwt

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/go-errors/errors"
	"github.com/golang-jwt/jwt/v5"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/config"
)

func Run(ctx context.Context, claims jwt.Claims, w io.Writer, fsys afero.Fs) error {
	if err := flags.LoadConfig(fsys); err != nil {
		return err
	}
	key, err := getSigningKey(ctx)
	if err != nil {
		return err
	}
	token, err := config.GenerateAsymmetricJWT(*key, claims)
	if err != nil {
		return err
	}
	fmt.Fprintln(w, token)
	return nil
}

func getSigningKey(ctx context.Context) (*config.JWK, error) {
	console := utils.NewConsole()
	if len(utils.Config.Auth.SigningKeysPath) == 0 {
		title := "Enter your signing key in JWK format (or leave blank to use local default): "
		kid, err := console.PromptText(ctx, title)
		if err != nil {
			return nil, err
		}
		if len(kid) == 0 && len(utils.Config.Auth.SigningKeys) > 0 {
			return &utils.Config.Auth.SigningKeys[0], nil
		}
		key := config.JWK{}
		if err := json.Unmarshal([]byte(kid), &key); err != nil {
			return nil, errors.Errorf("failed to parse JWK: %w", err)
		}
		return &key, nil
	}
	// Allow manual kid entry on CI
	if !console.IsTTY {
		title := "Enter the kid of your signing key (or leave blank to use the first one): "
		kid, err := console.PromptText(ctx, title)
		if err != nil {
			return nil, err
		}
		for i, k := range utils.Config.Auth.SigningKeys {
			if k.KeyID == kid {
				return &utils.Config.Auth.SigningKeys[i], nil
			}
		}
		if len(kid) == 0 && len(utils.Config.Auth.SigningKeys) > 0 {
			return &utils.Config.Auth.SigningKeys[0], nil
		}
		return nil, errors.Errorf("signing key not found: %s", kid)
	}
	// Let user choose from a list of signing keys
	items := make([]utils.PromptItem, len(utils.Config.Auth.SigningKeys))
	for i, k := range utils.Config.Auth.SigningKeys {
		items[i] = utils.PromptItem{
			Index:   i,
			Summary: k.KeyID,
			Details: fmt.Sprintf("%s (%s)", k.Algorithm, strings.Join(k.KeyOps, ",")),
		}
	}
	choice, err := utils.PromptChoice(ctx, "Select a signing key:", items)
	if err != nil {
		return nil, err
	}
	fmt.Fprintln(os.Stderr, "Selected key ID:", choice.Summary)
	return &utils.Config.Auth.SigningKeys[choice.Index], nil
}
