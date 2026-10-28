SHELL := /bin/bash

DATA_ROOT ?= data/raw
SUBS_FILE ?= configs/subreddits.txt
DAYS ?= 16

PORT ?= 8000
ADDR ?= 0.0.0.0
ZOLA ?= zola

ARCTIC_DIR ?= data/arctic
ARCTIC_FILES ?= $(wildcard $(ARCTIC_DIR)/*.jsonl)

.PHONY: harvest backfill media build ci import-arctic zola-serve zola-build zola-clean

harvest:
	go run ./cmd/harvest -root $(DATA_ROOT) -subs $(SUBS_FILE) -days $(DAYS)

backfill:
	python3 scripts/import_arctic.py --root $(DATA_ROOT) --fetch $(SUBS_FILE) --days $(DAYS)

media:
	python3 scripts/media.py --root $(DATA_ROOT)

build:
	python3 scripts/build.py $(DATA_ROOT) content

ci: harvest backfill media build

import-arctic:
	python3 scripts/import_arctic.py --root $(DATA_ROOT) $(ARCTIC_FILES)

zola-serve:
	$(ZOLA) serve --interface $(ADDR) --port $(PORT) --base-url localhost

zola-build:
	$(ZOLA) build --output-dir public

zola-clean:
	rm -rf content public
