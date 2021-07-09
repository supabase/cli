package deploy

import "fmt"

func Deploy() {
	fmt.Println("deploy")

	// apply unapplied migrations based on `schema_migrations` table and `migrations` dir
}
