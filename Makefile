.DEFAULT_GOAL := help

LEVEL ?= patch

.PHONY: build check clean docs fix fmt format help lint lint-docs release smoke test test-aplus test-deno test-doctest typecheck

# Compiles lib/ + mod.ts to dist/ (ESM + .d.ts + maps). The `.ts` import specifiers in the
# source are rewritten to `.js` by tsc's rewriteRelativeImportExtensions, which is what lets
# the same files be run directly by node/deno AND resolve through the npm exports map.
build:
	npm run build

# Everything CI runs, in the order that fails cheapest first.
check: format lint lint-docs typecheck test-doctest test test-deno test-aplus

clean:
	rm -rf dist docs/api node_modules

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
	@echo "  build         Compile lib/ + mod.ts to dist/ (ESM + .d.ts + maps)"
	@echo "  check         Everything CI runs: format, lint, doc gates, tests on both runtimes"
	@echo "  clean         Remove dist/, docs/api/ and node_modules/"
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
