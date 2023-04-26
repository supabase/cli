package credentials

import (
	"fmt"
	"os"

	"golang.org/x/term"
)

func PromptMasked(stdin *os.File) string {
	bytepw, err := term.ReadPassword(int(stdin.Fd()))
	fmt.Println()
	if err != nil {
		return ""
	}
	return string(bytepw)
}
