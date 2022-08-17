package apitest

import (
	"fmt"

	"gopkg.in/h2non/gock.v1"
)

func ListUnmatchedRequests() []string {
	result := make([]string, len(gock.GetUnmatchedRequests()))
	for i, r := range gock.GetUnmatchedRequests() {
		result[i] = fmt.Sprintln(r.Method, r.URL.Path)
	}
	return result
}
