SHELL := /bin/bash

DATA_ROOT ?= data/raw
STAGED_ROOT ?= data/staged
SUBS_FILE ?= configs/subreddits.txt
DAYS ?= 4096

VENV ?= .venv
PY ?= $(VENV)/bin/python
MKDOCS ?= $(VENV)/bin/mkdocs

PORT ?= 8000
ADDR ?= 0.0.0.0
GEN_RECENT ?= 64

.PHONY: deps harvest jsonl2md docs sync serve serve-static build clean

deps:
	apt-get update && apt-get install -y python3 python3-venv jq pandoc
	test -d $(VENV) || python3 -m venv $(VENV)
	$(VENV)/bin/pip install --upgrade pip
	$(VENV)/bin/pip install -r requirements.txt

harvest:
	DAYS=$(DAYS) bash scripts/harvest.sh $(DATA_ROOT) $(SUBS_FILE)

jsonl2md:
	bash scripts/jsonl2md.sh $(DATA_ROOT) $(STAGED_ROOT)

docs:
	GEN_RECENT=$(GEN_RECENT) $(PY) scripts/materialize_docs.py $(STAGED_ROOT) docs

sync: harvest jsonl2md docs

serve:
	$(MAKE) docs
	$(MKDOCS) serve --dev-addr=$(ADDR):$(PORT) -v

serve-static:
	$(MAKE) docs
	$(MKDOCS) build --strict
	python3 -m http.server $(PORT) -d site --bind $(ADDR)

build:
	$(MAKE) docs
	$(MKDOCS) build --strict

clean:
	rm -rf site $(VENV) docs/*
