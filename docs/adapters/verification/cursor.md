# Cursor Agent Verification

## Local Version

```text
cursor-agent 2026.05.07-42ddaca
```

## Result

The CLI exists locally.

`cursor-agent status` failed with:

```text
SecItemCopyMatching failed -50
```

## Decision

Defer Cursor adapter work until auth/keychain behavior and stream-json event shape are verified.
