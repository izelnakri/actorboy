.DEFAULT_GOAL := help

LEVEL ?= patch

.PHONY: bench bench-check bench-update build check ci clean coverage docs fix fmt format help lint lint-docs release smoke test test-aplus test-deno test-doctest typecheck

# Runs every benchmark and prints the table (no gate). Deno-only surface: Deno.bench.
bench:
	deno task bench

# The gate CI runs: each bench file in its own subprocess, compared against the committed
# baseline in benches/results.json. Sub-millisecond benches are observational — they colour
# and print but only fail the build at 10x the threshold, because commodity-hardware noise
# at that scale is indistinguishable from a real regression.
bench-check:
	deno task bench:check

# Re-records the baseline. Do this on an idle machine, and commit the result with the change
# that justifies it.
bench-update:
	deno task bench:update

# Compiles lib/ + mod.ts to dist/ (ESM + .d.ts + maps). The `.ts` import specifiers in the
# source are rewritten to `.js` by tsc's rewriteRelativeImportExtensions, which is what lets
# the same files be run directly by node/deno AND resolve through the npm exports map.
build:
	npm run build

# Everything CI runs, in the order that fails cheapest first.
check: format lint lint-docs typecheck test-doctest test test-deno test-aplus

# `check` plus the two gates that need a build or a baseline — the full CI surface, locally.
ci: check bench-check smoke

clean:
	rm -rf dist docs/api node_modules _site tmp

# Writes tmp/lcov.info (uploaded to Codecov from the ubuntu lane) alongside the JUnit XML.
coverage:
	npm run test:coverage

# Regenerates the HTML API reference into docs/api (gitignored — published, not committed).
docs:
	npm run docs

fix:
	npm run format:fix

fmt: fix

format:
	npm run format

help:
	@echo "Usage: make <target> [LEVEL=patch|minor|major]"
	@echo ""
	@echo "  bench         Run every benchmark and print the table (no gate)"
	@echo "  bench-check   Compare benchmarks against benches/results.json (the CI gate)"
	@echo "  bench-update  Re-record the benchmark baseline"
	@echo "  build         Compile lib/ + mod.ts to dist/ (ESM + .d.ts + maps)"
	@echo "  check         Everything CI runs: format, lint, doc gates, tests on both runtimes"
	@echo "  ci            check + bench-check + smoke — the full CI surface, locally"
	@echo "  clean         Remove dist/, docs/api/, _site/, tmp/ and node_modules/"
	@echo "  coverage      Run the suite with coverage → tmp/lcov.info + tmp/junit-node.xml"
	@echo "  docs          Generate the HTML API reference into docs/api"
	@echo "  fix           Auto-fix formatting (alias: fmt)"
	@echo "  format        Check formatting (prettier)"
	@echo "  lint          Check code quality (deno lint, incl. JSR slow-type rules)"
	@echo "  lint-docs     Enforce a runnable example on every public symbol"
	@echo "  release       Bump, changelog, tag, push, publish to npm AND JSR"
	@echo "  smoke         Pack the tarball and import every entry point as a consumer"
	@echo "  test          Run the suite under node --test"
	@echo "  test-aplus    Run the official Promises/A+ suite against Task (872 tests)"
	@echo "  test-deno     Run the same suite under deno test"
	@echo "  test-doctest  RUN every JSDoc example under a near-zero-permission sandbox"
	@echo "  typecheck     Type-check lib/ and every JSDoc example (deno check --doc)"

lint:
	npm run lint

lint-docs:
	npm run lint:docs

# Bump, verify, publish to both registries, then commit/tag/push.
#
# Order matters: publish before commit/tag so a registry rejection (a taken name, a failed
# 2FA) leaves no orphan tag pointing at a version that does not exist. npm goes first because
# it is the one that can fail on name availability; JSR follows with --allow-dirty, since the
# bumped deno.json version is not committed until the step after.
#
# Usage: make release LEVEL=patch|minor|major
release:
	@test -n "$(LEVEL)" || (echo "Usage: make release LEVEL=patch|minor|major" && exit 1)
	@if [ -n "$$(git status --porcelain)" ]; then \
		echo "WARNING: Uncommitted changes detected — these will NOT be included in the release:"; \
		git status --short; \
		echo ""; \
	fi
	@npm whoami > /dev/null 2>&1 || npm login
	@echo "npm user: $$(npm whoami)"
	$(MAKE) check
	$(MAKE) smoke
	npm version $(LEVEL) --no-git-tag-version
	@VERSION=$$(node -p 'require("./package.json").version'); \
	node -e 'const fs=require("fs"),f="deno.json",v=process.argv[1];fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(/("version":\s*")[^"]+/,(_,head)=>head+v))' $$VERSION
	npm publish --access public
	deno publish --allow-dirty
	git-cliff --tag "v$$(node -p 'require("./package.json").version')" --output CHANGELOG.md
	git add package.json package-lock.json deno.json CHANGELOG.md
	git commit -m "Release $$(node -p 'require("./package.json").version')"
	git tag "v$$(node -p 'require("./package.json").version')"
	git push && git push --tags

# The consumer's view: pack the tarball, install it into a throwaway project, import every
# entry point of the exports map from outside the package. Requires a fresh `make build`.
smoke: build
	node scripts/smoke-package.js

test:
	npm test

test-aplus:
	npm run test:aplus

test-deno:
	npm run test:deno

test-doctest:
	npm run test:doctest

typecheck:
	npm run typecheck
