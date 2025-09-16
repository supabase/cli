package bearerjwt

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/config"
)

func Run(ctx context.Context, claims config.CustomClaims, w io.Writer, fsys afero.Fs) error {
	if err := flags.LoadConfig(fsys); err != nil {
		return err
	}
	// Set is_anonymous = true for authenticated role without explicit user ID
	if strings.EqualFold(claims.Role, "authenticated") && len(claims.Subject) == 0 {
		claims.IsAnon = true
	}
	// Use the first signing key that passes validation
	for _, k := range utils.Config.Auth.SigningKeys {
		fmt.Fprintln(os.Stderr, "Using signing key ID:", k.KeyID.String())
		if token, err := config.GenerateAsymmetricJWT(k, claims); err != nil {
			fmt.Fprintln(os.Stderr, err)
		} else {
			fmt.Fprintln(w, token)
			return nil
		}
	}
	fmt.Fprintln(os.Stderr, "Using legacy JWT secret...")
	token, err := claims.NewToken().SignedString([]byte(utils.Config.Auth.JwtSecret.Value))
	if err != nil {
		return errors.Errorf("failed to generate auth token: %w", err)
	}
	fmt.Fprintln(w, token)
	return nil
}
