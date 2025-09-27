SHELL := /bin/bash
DATA_ROOT ?= data/raw
STAGED_ROOT ?= data/staged
SUBS_FILE ?= configs/subreddits.txt
DAYS ?= 3
VENV ?= .venv
MKDOCS ?= $(VENV)/bin/mkdocs
PORT ?= 8000
ADDR ?= 0.0.0.0
GEN_RECENT ?= 20
JSON2MD ?= scripts/jsonl2md

.PHONY: deps harvest jsonl2md ensure-index serve serve-static build all clean

deps:
	apt-get update && apt-get install -y python3 python3-venv jq pandoc
	test -d $(VENV) || python3 -m venv $(VENV)
	$(VENV)/bin/pip install --upgrade pip
	$(VENV)/bin/pip install -r requirements.txt

harvest:
	DAYS=$(DAYS) bash scripts/harvest.sh $(DATA_ROOT) $(SUBS_FILE)

jsonl2md:
	$(JSON2MD) $(DATA_ROOT) $(STAGED_ROOT)

ensure-index:
	bash scripts/ensure_index.sh $(STAGED_ROOT)

serve:
	GEN_RECENT=$(GEN_RECENT) $(MAKE) ensure-index
	GEN_RECENT=$(GEN_RECENT) $(MKDOCS) serve --dev-addr=$(ADDR):$(PORT) -v

serve-static:
	GEN_RECENT=$(GEN_RECENT) $(MAKE) ensure-index
	GEN_RECENT=$(GEN_RECENT) $(MKDOCS) build --strict
	python3 -m http.server $(PORT) -d site --bind $(ADDR)

build:
	GEN_RECENT=$(GEN_RECENT) $(MAKE) ensure-index
	GEN_RECENT=$(GEN_RECENT) $(MKDOCS) build --strict

all: harvest jsonl2md build

clean:
	rm -rf site $(VENV)
