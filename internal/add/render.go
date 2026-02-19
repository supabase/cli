package add

import (
	"fmt"
	"os"
	"regexp"
	"strings"
)

var templateExprPattern = regexp.MustCompile(`\{\{\s*([^{}]+?)\s*\}\}`)

func renderValue(input string, context map[string]string, refs map[string]string) (string, error) {
	if len(input) == 0 || !strings.Contains(input, "{{") {
		return input, nil
	}
	var renderErr error
	rendered := templateExprPattern.ReplaceAllStringFunc(input, func(match string) string {
		if renderErr != nil {
			return match
		}
		expr := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(match, "{{"), "}}"))
		if strings.HasPrefix(expr, "context.") || strings.HasPrefix(expr, "inputs.") {
			key := strings.TrimPrefix(strings.TrimPrefix(expr, "context."), "inputs.")
			value, ok := context[key]
			if !ok {
				renderErr = fmt.Errorf("missing context value: %s", key)
				return match
			}
			return value
		}
		if strings.HasPrefix(expr, "env.") {
			key := strings.TrimPrefix(expr, "env.")
			value, ok := os.LookupEnv(key)
			if !ok {
				// Leave missing env placeholders untouched instead of failing.
				return match
			}
			return value
		}
		if value, ok := refs[expr]; ok {
			return value
		}
		renderErr = fmt.Errorf("missing template reference: %s", expr)
		return match
	})
	return rendered, renderErr
}
