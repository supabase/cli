package utils

import "regexp"

func IsValidTimeSecondLiteral(s string) bool {
	re := regexp.MustCompile(`\d+s`)
	return re.MatchString(s)
}
