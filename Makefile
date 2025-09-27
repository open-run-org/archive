SHELL := /bin/bash

MKDOCS ?= mkdocs
PANDOC ?= pandoc

GO_CMD_DIR ?= ./cmd/harvester

DOCS_DIR ?= docs
SITE_DIR ?= site
PORT ?= 8000
ADDR ?= 0.0.0.0

.PHONY: harvest serve build clean check \
        go-build go-run go-test go-fmt go-tidy \
        html2md md2html

harvest:
	bash scripts/harvest.sh

serve:
	$(MKDOCS) serve -a $(ADDR):$(PORT)

build:
	$(MKDOCS) build --strict

clean:
	rm -rf "$(SITE_DIR)"

check:
	$(MKDOCS) get-deps || true

go-build:
	go build $(GOFLAGS) $(GO_CMD_DIR)

go-run:
	go run $(GO_CMD_DIR)

go-test:
	go test ./... -v

go-fmt:
	go fmt ./...

go-tidy:
	go mod tidy

html2md:
	@echo "Use: $(PANDOC) -f html -t gfm input.html -o output.md"

md2html:
	@echo "Use: $(PANDOC) -f gfm -t html -s input.md -o output.html"
