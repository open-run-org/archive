set shell := ["bash", "-euo", "pipefail", "-c"]

root := env_var_or_default("DATA_ROOT", "data/raw")
subs := env_var_or_default("SUBS_FILE", "configs/subreddits.txt")
days := env_var_or_default("DAYS", "16")
py := "uv run --locked"

default:
    @just --list

harvest:
    go run ./cmd/harvest -root {{ root }} -subs {{ subs }} -days {{ days }}

backfill:
    python3 scripts/import_arctic.py --root {{ root }} --fetch {{ subs }} --days {{ days }}

media:
    python3 scripts/media.py --root {{ root }}

build:
    python3 scripts/build.py {{ root }} content

ci: harvest backfill media build

import-arctic +files:
    python3 scripts/import_arctic.py --root {{ root }} {{ files }}

serve port="8000":
    zola serve --interface 0.0.0.0 --port {{ port }} --base-url localhost

site:
    zola build --output-dir public

clean:
    rm -rf content public

fmt:
    gofmt -w cmd
    {{ py }} ruff format scripts
    {{ py }} ruff check --fix scripts
    just --fmt --unstable

lint:
    test -z "$(gofmt -l cmd)"
    go vet ./...
    {{ py }} ruff format --check scripts
    {{ py }} ruff check scripts
    for f in static/archive.js bot/*.js bot/src/*.js; do node --check "$f"; done
    just --fmt --check --unstable
