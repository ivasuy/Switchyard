# Paperclip Adapter

## Target

Paperclip is a wrapper runtime target. Switchyard should expose Paperclip-backed agents as normal runs while keeping Paperclip-specific control inside the adapter.

The current scaffold is `paperclip.async_rest`.

## Preferred Protocol

- HTTP/API adapter once the API is verified.

## Implementation Notes

- Treat Paperclip as one runtime target.
- Map Paperclip task status and artifacts into normalized Switchyard events.
- Preserve wrapper-level audit data.
- The current adapter exposes manifest/check coverage and returns safe start denial.

## Status

Scaffolded. Execution remains deferred until source/API boundary fixtures are available.
