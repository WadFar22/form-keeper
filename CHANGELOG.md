# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.1] - 2026-09-15

**Fixed:** Resolved an Angular Material bug where injected dates would incorrectly swap days and months.

## [1.1.0] - 2026-09-12

### Added
- **Light Theme:** Added a new appearance toggle in the Options menu to switch between Dark and Light interface modes.
- **Repository Guardrails:** Fixed tracking rules to strictly block accidental commits of packaged `.zip` files.

### Fixed
- **Framework Compatibility:** Introduced a bug fix for more Compatibility with frameworks (like Angular and React).

## [1.0.0] - 2026-08-30

### Added
- Initial public release for Chrome Web Store and Microsoft Edge Add-ons.
- Zero-telemetry, local-only architecture utilizing Manifest V3 and `chrome.storage.local`.