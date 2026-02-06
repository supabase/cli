package add

import (
	"fmt"
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
		if strings.HasPrefix(expr, "context.") {
			key := strings.TrimPrefix(expr, "context.")
			value, ok := context[key]
			if !ok {
				renderErr = fmt.Errorf("missing context value: %s", key)
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
