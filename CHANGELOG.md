# Changelog

All notable changes to Switchyard will be documented in this file.

## 0.1.0 - 2026-05-11

### Added

- Initialized the Switchyard TypeScript monorepo with pnpm workspaces and Turborepo.
- Added strict shared TypeScript, Vitest, and editor configuration.
- Added `@switchyard/contracts` with Zod schemas and inferred types for runs, sessions, debates, events, messages, artifacts, approvals, memory, evidence, tools, registry records, placement, nodes, users, budgets, context, and errors.
- Added `@switchyard/core` with protocol-neutral ports and initial service shells for runs, events, sessions, debates, messages, artifacts, approvals, memory, evidence, tools, registry, placement, and context building.
- Added `@switchyard/testkit` with deterministic fake runtime adapters, in-memory stores, and fixtures for contract-first development.
- Added root workspace scripts for build, test, typecheck, and lint.
- Added public architecture documentation with repository shape, deployment modes, protocol choices, remote-node control, and package responsibilities.
- Added adapter research and verification docs for OpenCode, Claude Code, Codex, Cursor Agent, AgentField, Generic HTTP, OpenClaw, and Paperclip.

### Changed

- Expanded `.gitignore` to keep generated artifacts, dependencies, caches, environment files, logs, editor files, `docs/decisions`, and `docs/superpowers` out of the repository.
