# Claudeway — unified build commands
#
# Usage:
#   make              — build everything (server + android)
#   make server-*     — server targets (build, test, lint, etc.)
#   make android-*    — android targets (build, test, lint, etc.)
#   make help         — show all targets

.PHONY: help all clean
.DEFAULT_GOAL := help

# --- Environment ---

JAVA_HOME  ?= /opt/homebrew/opt/openjdk@17
ANDROID_HOME ?= $(HOME)/Library/Android/sdk
export JAVA_HOME ANDROID_HOME
export PATH := $(JAVA_HOME)/bin:$(PATH)

GRADLE := cd android && gradle

# ============================================================
# Top-level
# ============================================================

all: server-build android-build ## Build everything

test: server-test android-test ## Run all tests

lint: server-lint android-lint ## Lint everything

clean: server-clean android-clean ## Clean all build artifacts

# ============================================================
# Server (TypeScript / Bun)
# ============================================================

.PHONY: server-build server-test server-lint server-format server-typecheck server-dev server-start server-clean

server-build: ## Compile TypeScript
	bun run build

server-test: ## Run server tests
	bun test

server-test-watch: ## Run server tests in watch mode
	bun test --watch

server-test-coverage: ## Run server tests with coverage
	bun test --coverage

server-lint: ## Lint server code
	bun run lint

server-format: ## Format server code
	bun run format

server-format-check: ## Check server formatting
	bun run format:check

server-typecheck: ## Type-check without emitting
	bun run typecheck

server-dev: ## Run server with auto-reload
	bun dev

server-start: ## Run server
	bun start

server-clean: ## Remove server build artifacts
	rm -rf dist

# ============================================================
# Android
# ============================================================

.PHONY: android-build android-test android-lint android-apk android-clean

android-build: ## Build Android debug + release
	$(GRADLE) build

android-debug: ## Build Android debug APK only
	$(GRADLE) assembleDebug

android-release: ## Build Android release APK only
	$(GRADLE) assembleRelease

android-test: ## Run Android unit tests
	$(GRADLE) test

android-lint: ## Run Android lint
	$(GRADLE) lint

android-apk: android-debug ## Build debug APK and print path
	@echo "APK: android/app/build/outputs/apk/debug/app-debug.apk"

android-clean: ## Remove Android build artifacts
	$(GRADLE) clean

android-install: android-debug ## Build and install debug APK on connected device
	$(ANDROID_HOME)/platform-tools/adb install -r android/app/build/outputs/apk/debug/app-debug.apk

# ============================================================
# Help
# ============================================================

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}' | \
		sort
