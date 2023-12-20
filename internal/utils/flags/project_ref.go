package flags

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/go-errors/errors"
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
	if _, err := LoadProjectRef(fsys); !errors.Is(err, utils.ErrNotLinked) {
		return err
	}
	// Prompt as the last resort
	if term.IsTerminal(int(os.Stdin.Fd())) {
		return promptProjectRef(os.Stdin)
	}
	return errors.New(utils.ErrNotLinked)
}

func promptProjectRef(stdin io.Reader) error {
	fmt.Fprintf(os.Stderr, `You can find your project ref from the project's dashboard home page, e.g. %s/project/<project-ref>.
Enter your project ref: `, utils.GetSupabaseDashboardURL())
	// Scan a single line for input
	scanner := bufio.NewScanner(stdin)
	scanner.Scan()
	if err := scanner.Err(); err != nil {
		return errors.Errorf("failed to read project ref: %w", err)
	}
	ProjectRef = strings.TrimSpace(scanner.Text())
	return utils.AssertProjectRefIsValid(ProjectRef)
}

func LoadProjectRef(fsys afero.Fs) (string, error) {
	projectRefBytes, err := afero.ReadFile(fsys, utils.ProjectRefPath)
	if errors.Is(err, os.ErrNotExist) {
		return "", errors.New(utils.ErrNotLinked)
	} else if err != nil {
		return "", errors.Errorf("failed to load project ref: %w", err)
	}
	ProjectRef := string(bytes.TrimSpace(projectRefBytes))
	if err := utils.AssertProjectRefIsValid(ProjectRef); err != nil {
		return "", err
	}
	return ProjectRef, nil
}
