package jsonschema

const (
	String = "string"
	Object = "object"
)

type Definition struct {
	Type        string                `json:"type"`
	Properties  map[string]Definition `json:"properties,omitempty"`
	Required    []string              `json:"required,omitempty"`
	Enum        []string              `json:"enum,omitempty"`
	Description string                `json:"description,omitempty"`
}
