package config

// Helper function to get a pointer to a value
func ptr[T any](v T) *T {
	return &v
}

func compareSensitiveField[T comparable](local *T, remote *T) {
	if remote == nil {
		return
	}
	if *local != *remote {
		*local = any("<changed-sensitive-value-hidden>").(T)
		*remote = any("<original-sensitive-value-hidden>").(T)
	} else {
		*local = any("<unchanged-sensitive-value-hidden>").(T)
		*remote = any("<unchanged-sensitive-value-hidden>").(T)
	}
}
