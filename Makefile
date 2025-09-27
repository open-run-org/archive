SHELL := /bin/bash
DATA_ROOT ?= data/raw
SUBS_FILE ?= configs/subreddits.txt
DAYS ?= 3
MKDOCS ?= mkdocs
PORT ?= 8000
ADDR ?= 0.0.0.0

.PHONY: harvest jsonl2md serve build clean
harvest:
	DAYS=$(DAYS) bash scripts/harvest.sh $(DATA_ROOT) $(SUBS_FILE)
jsonl2md:
	bash scripts/jsonl2md.sh data/raw data/staged
serve:
	$(MKDOCS) serve -a $(ADDR):$(PORT)
build:
	$(MKDOCS) build --strict
clean:
	rm -rf site
