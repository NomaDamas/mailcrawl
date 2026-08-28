package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/go-ego/gse"
)

type request struct { Text string `json:"text"` }
type response struct {
	Ready bool `json:"ready,omitempty"`
	Tokens string `json:"tokens,omitempty"`
	Error string `json:"error,omitempty"`
	Version string `json:"version,omitempty"`
}

func main() {
	var segmenter gse.Segmenter
	if err := segmenter.LoadDictEmbed(); err != nil { write(response{Error: err.Error()}); os.Exit(2) }
	write(response{Ready: true, Version: "gse-search"})
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
		for _, value := range segmenter.CutSearch(input.Text, true) {
			value = strings.ToLower(strings.TrimSpace(value))
			if value == "" { continue }
			if _, ok := seen[value]; ok { continue }
			seen[value] = struct{}{}
			tokens = append(tokens, value)
		}
		write(response{Tokens: strings.Join(tokens, " ")})
	}
}

func write(value response) { _ = json.NewEncoder(os.Stdout).Encode(value) }
