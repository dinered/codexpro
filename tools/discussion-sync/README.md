# Discussion sync planner

`plan.mjs` is a read-only planner for the reviewed GitHub/GitLab issue and PR/MR mapping in `mappings.json`.

```sh
node tools/discussion-sync/plan.mjs --github-cli /home/paseo/.local/bin/gh
```

The planner uses the authenticated `gh` and `glab` CLIs, reads all pages, and emits a deterministic row for each discussion record, status conflict, inline comment or review. It hashes comment bodies instead of printing them. No endpoint used by this command writes data. Stable origin markers identify copied comments on later runs; a known marker is reported as `already_mirrored`. Attachments, review decisions and state conflicts remain review actions. The planner does not create comments or issues/MRs.

Tests:

```sh
node --test tools/discussion-sync/plan.test.mjs
```

No original author, timestamp, approval or merge state is recreated. Any future writer must use explicitly attributed informational copies, retain source links, and receive FirstMate review of an actual row-level plan before backfill.
