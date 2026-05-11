# Paperclip Adapter

## Target

Paperclip is a wrapper runtime target. Switchyard should expose Paperclip-backed agents as normal runs while keeping Paperclip-specific control inside the adapter.

## Preferred Protocol

- HTTP/API adapter once the API is verified.

## Implementation Notes

- Treat Paperclip as one runtime target.
- Map Paperclip task status and artifacts into normalized Switchyard events.
- Preserve wrapper-level audit data.

## Status

Deferred until source/API boundary is available.
