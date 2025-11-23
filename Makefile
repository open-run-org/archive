SHELL := /bin/bash

DATA_ROOT ?= data/raw
STAGED_ROOT ?= data/staged
SUBS_FILE ?= configs/subreddits.txt

DAYS ?= 16
PORT ?= 8000
ADDR ?= 0.0.0.0

VENV ?= .venv
PY ?= $(VENV)/bin/python
ZOLA ?= zola

GEN_RECENT ?= 64
PUSHSHIFT_DIR ?= data/pushshift
SINCE ?= 2021-01
UNTIL ?= $(shell date +%Y-%m)
WINDOW ?= 30

ARCTIC_DIR ?= data/arctic
ARCTIC_FILES ?= $(wildcard $(ARCTIC_DIR)/*.jsonl)

.PHONY: deps harvest harvest-comments jsonl2md-comments jsonl2md docs ci import-arctic zola-serve zola-build zola-clean

deps:
	@if [ -z "$$CI" ]; then \
	  apt-get update && apt-get install -y python3 python3-venv jq pandoc aria2 zstd curl xz-utils bzip2 gzip ; \
	else \
	  echo "[deps] CI=true detected, skip apt-get"; \
	fi
	test -d $(VENV) || python3 -m venv $(VENV)
	$(VENV)/bin/pip install --upgrade pip

harvest:
	DAYS=$(DAYS) bash scripts/harvest.sh $(DATA_ROOT) $(SUBS_FILE)

harvest-comments:
	DAYS=$(DAYS) bash scripts/harvest_comments.sh $(DATA_ROOT) $(SUBS_FILE)

jsonl2md:
	bash scripts/jsonl2md.sh $(DATA_ROOT) $(STAGED_ROOT)

jsonl2md-comments:
	bash scripts/jsonl2md_comments.sh $(DATA_ROOT) $(STAGED_ROOT)

docs:
	GEN_RECENT=$(GEN_RECENT) $(PY) scripts/materialize_docs.py $(STAGED_ROOT) content

ci:
	$(MAKE) harvest
	$(MAKE) harvest-comments
	$(MAKE) jsonl2md
	$(MAKE) jsonl2md-comments
	$(MAKE) docs
	@echo "[ci] pipeline done"

import-arctic:
	$(PY) scripts/import_arctic.py --root $(DATA_ROOT) $(ARCTIC_FILES)

zola-serve:
	$(ZOLA) serve --interface $(ADDR) --port $(PORT) --base-url $(ADDR)

zola-build:
	$(ZOLA) build --output-dir public

zola-clean:
	rm -rf content public
