package primitives

func Ptr[T any](v T) *T {
	return &v
}

func SafeBool(v *bool) bool {
	if v == nil {
		return false
	}
	return *v
}
