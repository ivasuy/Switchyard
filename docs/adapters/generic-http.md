# Generic HTTP Adapter

## Target

Generic HTTP lets Switchyard integrate custom agents and wrappers that expose run/status/events-style APIs.

## Preferred Protocol

- HTTP create/status/events/cancel/artifacts endpoints.
- Optional webhook callback support.

## Expected Contract

- Start remote execution.
- Poll or stream status.
- Send input if supported.
- Cancel execution if supported.
- Collect artifacts and transcript.

## Implementation Notes

- Make endpoint names configurable.
- Validate provider/runtime/model metadata through registry records.
- Use this adapter as the base pattern for simple wrapper runtimes.

## Status

Ready for contract design.
