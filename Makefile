SHELL := /bin/bash
DATA_ROOT ?= data/raw
SUBS_FILE ?= configs/subreddits.txt
DAYS ?= 3
MKDOCS ?= mkdocs
PORT ?= 8000
ADDR ?= 0.0.0.0

.PHONY: harvest md-batch serve build clean
harvest:
	DAYS=$(DAYS) bash scripts/harvest.sh $(DATA_ROOT) $(SUBS_FILE)
md-batch:
	bash scripts/batch_jsonl_to_md.sh data/raw data/staged
serve:
	$(MKDOCS) serve -a $(ADDR):$(PORT)
build:
	$(MKDOCS) build --strict
clean:
	rm -rf site
