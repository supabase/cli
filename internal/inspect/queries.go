package inspect

import (
	"fmt"
	"os"
)

func ReadQuery(query string) string {
	path := fmt.Sprintf("./internal/inspect/queries/%s.sql", query)
	queryString, err := os.ReadFile(path)
	if err != nil {
		println(err.Error())
		return ""
	}
	return string(queryString)
}

func Report() error {
	queries, err := os.ReadDir("./internal/inspect/queries")
	if err != nil {
		return err
	}
	for _, v := range queries {
		fmt.Print(v.Name())
		// TODO: Run and export SQL as CSV
	}
	return nil
}
