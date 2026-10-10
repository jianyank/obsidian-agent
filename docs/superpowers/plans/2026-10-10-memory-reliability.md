# Obsidian Memory Reliability Implementation Plan

**Goal:** Make the four memory tools reliable without changing the desktop profile or real vault.

**Architecture:** Keep Vault, MemoryStore and prompt-card boundaries. Read full notes from Vault on demand, serialize writes, await scans before superseding, and keep retrieval lexical.

**Tech Stack:** JavaScript ESM, Node.js built-in test runner, installed Harness SDK.

## Constraints

- No automatic summarization, embedding service or new production dependency.
- No profile changes, installation or writes to the real Obsidian vault.
- Synchronous prompt providers use the last completed cache; tools await pending mutations.
- Chinese segmentation uses Intl.Segmenter; keyword search is not semantic retrieval.
- Not a Git repository: use the pre-edit snapshot for final file comparison.

## Tasks

1. Add failing pure tests for strict budgets, whole-entry cropping, Chinese queries, weighted tags and inactive filtering.
2. Add tool tests with real defineTool and an in-memory filesystem. Cover full reads, fresh metadata, cold/expired-cache superseding, concurrent writes, failure recovery and indexes.
3. Fix query normalization and scoring; keep search bodies bounded and read originals through Vault.
4. Serialize memory_write and await scans before and after mutations. Readers wait for writes; cards do not launch scans during mutations.
5. Crop at entry boundaries, counting the omission notice in the exact UTF-16 budget. Return empty text if even the header and notice cannot fit.
6. Add test scripts and README with cmd-compatible commands, config defaults, examples and limitations.

## Verification

- Run `node --test tests/*.test.mjs` in the plugin directory with installed SDK modules; never install packages for tests.
- Run `node _diag/memory-smoke.mjs` in the parent workspace.
- Run `node --check` on changed JavaScript.
- Compare originals to the baseline snapshot and report actual line counts.
- Confirm profile files and vault contents remain unchanged.
