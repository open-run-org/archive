SHELL := /bin/bash

DATA_ROOT ?= data/raw
STAGED_ROOT ?= data/staged
SUBS_FILE ?= configs/subreddits.txt

DAYS ?= 16
PORT ?= 8000
ADDR ?= 0.0.0.0

VENV ?= .venv
PY ?= $(VENV)/bin/python
MKDOCS ?= $(VENV)/bin/mkdocs

GEN_RECENT ?= 64
PUSHSHIFT_DIR ?= data/pushshift
SINCE ?= 2021-01
UNTIL ?= $(shell date +%Y-%m)
WINDOW ?= 30

WHICH ?= both
AT_MONTHLY_SUBS_MAGNET ?= magnet:?xt=urn:btih:30dee5f0406da7a353aff6a8caa2d54fd01f2ca1
AT_MONTHLY_COMMENTS_MAGNET ?= magnet:?xt=urn:btih:30dee5f0406da7a353aff6a8caa2d54fd01f2ca1
AT_TRACKERS ?= udp://tracker.opentrackr.org:1337/announce,https://tracker.zhuqiy.com:443/announce

ARCTIC_DIR ?= data/arctic
ARCTIC_FILES ?= $(wildcard $(ARCTIC_DIR)/*.jsonl)

.PHONY: deps fetch-monthly ids hydrate sync-backfill jsonl2md docs serve build sync harvest harvest-comments jsonl2md-comments ci import-arctic

deps:
	@if [ -z "$$CI" ]; then \
	  apt-get update && apt-get install -y python3 python3-venv jq pandoc aria2 zstd curl xz-utils bzip2 gzip ; \
	else \
	  echo "[deps] CI=true detected, skip apt-get"; \
	fi
	test -d $(VENV) || python3 -m venv $(VENV)
	$(VENV)/bin/pip install --upgrade pip
	$(VENV)/bin/pip install -r requirements.txt

fetch-monthly:
	PYTHONUNBUFFERED=1 AT_MONTHLY_SUBS_MAGNET="$(AT_MONTHLY_SUBS_MAGNET)" AT_MONTHLY_COMMENTS_MAGNET="$(AT_MONTHLY_COMMENTS_MAGNET)" AT_TRACKERS="$(AT_TRACKERS)" \
	python3 -u scripts/fetch_pushshift_auto.py --out-dir "$(PUSHSHIFT_DIR)" --since "$(SINCE)" --until "$(UNTIL)" --concurrency 8 --which "$(WHICH)" --verbose

ids:
	@set -e; \
	while read -r s; do \
	  case "$$s" in \#*|"") continue;; esac; \
	  python3 scripts/pushshift2ids.py --sub="$$s" --in-glob "$(PUSHSHIFT_DIR)/*"; \
	done < "$(SUBS_FILE)"

hydrate:
	@set -e; \
	while read -r s; do \
	  case "$$s" in \#*|"") continue;; esac; \
	  python3 scripts/pushshift2ids.py --sub="$$s" --in-glob "$(PUSHSHIFT_DIR)/*" > "$(PUSHSHIFT_DIR)/r_$${s}_ids.txt"; \
	  go run ./cmd/hydrate -sub "$$s" -root "$(DATA_ROOT)" -in "$(PUSHSHIFT_DIR)/r_$${s}_ids.txt"; \
	done < "$(SUBS_FILE)"

sync-backfill:
	@set -e; \
	while read -r s; do \
	  case "$$s" in \#*|"") continue;; esac; \
	  go run ./cmd/sync -sub "$$s" -root "$(DATA_ROOT)" -window $(WINDOW) -limit 100 -empty 8; \
	done < "$(SUBS_FILE)"

jsonl2md:
	bash scripts/jsonl2md.sh $(DATA_ROOT) $(STAGED_ROOT)

docs:
	GEN_RECENT=$(GEN_RECENT) $(PY) scripts/materialize_docs.py $(STAGED_ROOT) docs

serve:
	$(MKDOCS) serve --dev-addr=$(ADDR):$(PORT) -v

build:
	$(MKDOCS) build --strict

sync: deps fetch-monthly hydrate sync-backfill jsonl2md docs build

harvest:
	DAYS=$(DAYS) bash scripts/harvest.sh $(DATA_ROOT) $(SUBS_FILE)

harvest-comments:
	DAYS=$(DAYS) bash scripts/harvest_comments.sh $(DATA_ROOT) $(SUBS_FILE)

jsonl2md-comments:
	bash scripts/jsonl2md_comments.sh $(DATA_ROOT) $(STAGED_ROOT)

ci:
	$(MAKE) harvest
	$(MAKE) harvest-comments
	$(MAKE) jsonl2md
	$(MAKE) jsonl2md-comments
	$(MAKE) docs
	@echo "[ci] pipeline done"

import-arctic:
	$(PY) scripts/import_arctic.py --root $(DATA_ROOT) $(ARCTIC_FILES)
