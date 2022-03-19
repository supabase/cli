package new

import (
	"errors"
	"os"

	"github.com/supabase/cli/internal/utils"
)

func Run(migrationName string) error {
	if _, err := os.ReadDir("supabase"); errors.Is(err, os.ErrNotExist) {
		return errors.New("Cannot find " + utils.Bold("supabase") + " in the current directory. Have you set up the project with " + utils.Aqua("supabase init") + "?")
	} else if err != nil {
		return err
	}

	if err := utils.MkdirIfNotExist("supabase/migrations"); err != nil {
		return err
	}

	timestamp := utils.GetCurrentTimestamp()
	return os.WriteFile("supabase/migrations/"+timestamp+"_"+migrationName+".sql", []byte{}, 0644)
}
