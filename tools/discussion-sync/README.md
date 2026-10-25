# Discussion sync planner

`plan.mjs` is a read-only planner for the reviewed GitHub/GitLab issue and PR/MR mapping in `mappings.json`. It also inventories every currently unmapped issue and PR/MR and their discussion/review records so the plan cannot silently omit a source object.

```sh
node tools/discussion-sync/plan.mjs --github-cli /home/paseo/.local/bin/gh
```

The planner uses explicitly addressed GitHub and GitLab hosts through the authenticated `gh` and `glab` CLIs. It bounds each CLI call and pagination to 20 seconds and 100 pages. Output is deterministic and contains metadata plus body hashes, never comment text. Exact generated informational envelopes are trusted only when the target API author matches the configured service actor and the hash of the enclosed original body matches the marker. Embedded, quoted, malformed, actor-mismatched, or edited envelopes are conflicts. Stable IDs include the service host and full project identity. GitLab inline notes are excluded from ordinary note rows and represented once through their discussion/thread metadata. The command does not create comments or issues/MRs.

Tests:

```sh
node --test tools/discussion-sync/plan.test.mjs
```

No original author, timestamp, approval or merge state is recreated. The current row plan is still read-only. Any writer must re-fetch and hash the source immediately before each write, preserve an idempotent origin marker on the remote mirror as the durable mapping/checkpoint, stop on concurrent target edits, represent source edits as attributed revisions, and default to dry-run. FirstMate must review the exact row plan before backfill.

The shared `merge-train-smoke` runner does not provide Node, so it cannot execute `node --test` for this planner. Do not treat its existing `smoke` or `sync-github-test` jobs as planner tests. Recurring integration remains gated until a CI-compatible functional runner path and the exact additional GitHub Issues/Pull requests write capabilities have been established.
