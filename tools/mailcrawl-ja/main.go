package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/ikawaha/kagome-dict/ipa"
	"github.com/ikawaha/kagome/v2/tokenizer"
)

type request struct { Text string `json:"text"` }
type response struct {
	Ready bool `json:"ready,omitempty"`
	Tokens string `json:"tokens,omitempty"`
	Error string `json:"error,omitempty"`
	Version string `json:"version,omitempty"`
}

func main() {
	analyzer, err := tokenizer.New(ipa.Dict(), tokenizer.OmitBosEos())
	if err != nil { write(response{Error: err.Error()}); os.Exit(2) }
	write(response{Ready: true, Version: "kagome-ipa-search"})
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 8*1024*1024)
	for scanner.Scan() {
		var input request
		if err := json.Unmarshal(scanner.Bytes(), &input); err != nil {
			write(response{Error: fmt.Sprintf("decode request: %v", err)})
			continue
		}
		seen := map[string]struct{}{}
		tokens := []string{}
		add := func(value string) {
			value = strings.ToLower(strings.TrimSpace(value))
			if value == "" || value == "*" { return }
			if _, ok := seen[value]; ok { return }
			seen[value] = struct{}{}
			tokens = append(tokens, value)
		}
		for _, token := range analyzer.Analyze(input.Text, tokenizer.Search) {
			add(token.Surface)
			features := token.Features()
			if len(features) > 6 { add(features[6]) }
		}
		write(response{Tokens: strings.Join(tokens, " ")})
	}
}

func write(value response) { _ = json.NewEncoder(os.Stdout).Encode(value) }
