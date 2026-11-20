# Project instructions

## Git commits
- Never add Codex or Anthropic co-author trailers to commit messages.
- Do not add generated-by attribution to commits or PR bodies.

## Explaining changes
- After changing code, show the user the changed file paths as clickable links and the relevant code snippets or diffs.
- Explain briefly what each change does and how it fits into the app's infrastructure, so the user can understand the implementation.

## Handover and architecture
- Start with [README.md](README.md) and [docs/HANDOVER.md](docs/HANDOVER.md) for runtime ownership, setup, agent invariants, verification and known limitations.
- Treat source and launch configuration as authoritative when older documentation differs. Update relevant documentation when behavior changes.
- Preserve existing local changes. Use synthetic fixtures for evaluation; do not inspect real private conversation/trace payloads without user authorization.
