package utils

import (
	"fmt"
	"strings"

	"github.com/go-errors/errors"
)

// Ref: https://github.com/spf13/pflag/issues/236#issuecomment-931600452
type EnumFlag struct {
	Allowed []string
	Value   string
}

func (a EnumFlag) String() string {
	return a.Value
}

func (a *EnumFlag) Set(p string) error {
	if !SliceContains(a.Allowed, p) {
		return errors.Errorf("must be one of [ %s ]", strings.Join(a.Allowed, " | "))
	}
	a.Value = p
	return nil
}

func (a *EnumFlag) Type() string {
	values := strings.Join(a.Allowed, " | ")
	if len(values) < 40 {
		return fmt.Sprintf("[ %s ]", values)
	}
	return "string"
}
