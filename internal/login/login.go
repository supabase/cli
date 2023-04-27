package login

import (
	"fmt"
	"os"
	"strings"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
)

func Run(stdin *os.File, fsys afero.Fs) error {
	accessToken := PromptAccessToken(stdin)
	return utils.SaveAccessToken(accessToken, fsys)
}

func PromptAccessToken(stdin *os.File) string {
	fmt.Fprintf(os.Stderr, `You can generate an access token from %s/account/tokens
Enter your access token: `, utils.GetSupabaseDashboardURL())
	input := credentials.PromptMasked(stdin)
	return strings.TrimSpace(input)
}
