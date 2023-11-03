package flags

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
	"golang.org/x/term"
)

var ProjectRef string

func ParseProjectRef(fsys afero.Fs) error {
	// Flag takes highest precedence
	if len(ProjectRef) == 0 {
		ProjectRef = viper.GetString("PROJECT_ID")
	}
	if len(ProjectRef) > 0 {
		return utils.AssertProjectRefIsValid(ProjectRef)
	}
	// Followed by linked ref file
	if projectRefBytes, err := afero.ReadFile(fsys, utils.ProjectRefPath); err == nil {
		ProjectRef = string(bytes.TrimSpace(projectRefBytes))
		return utils.AssertProjectRefIsValid(ProjectRef)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// Prompt as the last resort
	if term.IsTerminal(int(os.Stdin.Fd())) {
		return promptProjectRef(os.Stdin)
	}
	return utils.ErrNotLinked
}

func promptProjectRef(stdin io.Reader) error {
	fmt.Fprintf(os.Stderr, `You can find your project ref from the project's dashboard home page, e.g. %s/project/<project-ref>.
Enter your project ref: `, utils.GetSupabaseDashboardURL())
	// Scan a single line for input
	scanner := bufio.NewScanner(stdin)
	scanner.Scan()
	if err := scanner.Err(); err != nil {
		return err
	}
	ProjectRef = strings.TrimSpace(scanner.Text())
	return utils.AssertProjectRefIsValid(ProjectRef)
}
