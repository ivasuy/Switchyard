# Release Specs And Plans

This directory holds release planning artifacts. These files are execution aids, not product truth.

Product truth lives in `PRODUCT.md`. User-facing change history lives in `CHANGELOG.md`. System architecture lives in `ARCHITECTURE.md`.

## Active Document Rule

At any time, there should be at most:

- one active release spec in `docs/superpowers/specs/`.
- one active implementation plan in `docs/superpowers/plans/`.

Older specs and plans are historical references. They should not be used to decide what is shipped unless `PRODUCT.md` says the capability exists.

## Release Spec

A release spec should describe:

- the release goal.
- what becomes usable.
- what is explicitly not included.
- architecture boundaries that change.
- local verification required before release.
- docs that must be updated when the release ships.

## Implementation Plan

An implementation plan should describe:

- task order.
- files and packages to touch.
- tests to add or update.
- local smoke checks.
- release promotion steps.

When a release ships, update `PRODUCT.md`, `CHANGELOG.md`, and the development docs before starting the next active spec/plan pair.
