package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/supabase/cli/pkg/config"
)

func main() {
	if err := run(); err != nil {
		panic(err)
	}
}

func run() error {
	secret, err := jsonschema.For[config.Secret](&jsonschema.ForOptions{})
	if err != nil {
		return err
	}
	secretSchema, err := json.Marshal(secret)
	if err != nil {
		return err
	}
	// Replace secret schema because TypeSchemas is not working
	opts := &jsonschema.ForOptions{
		TypeSchemas: map[reflect.Type]*jsonschema.Schema{
			reflect.TypeFor[config.Secret](): {Type: "string"},
		},
	}
	js, err := jsonschema.For[config.Config](opts)
	if err != nil {
		return err
	}
	data, err := json.Marshal(js)
	if err != nil {
		return err
	}
	result := bytes.ReplaceAll(data, secretSchema, []byte(`{"type":"string"}`))
	_, err = fmt.Println(string(result))
	return err
}
