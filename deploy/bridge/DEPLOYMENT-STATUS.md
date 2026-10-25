# Deployed Web Bridge — 2026-10-25

The submission-attribution and Paseo envelope corrections from source
`52a07ce6b476526c8dd9ee9a276f530b1f3b8607` are installed. Two consecutive native
messages in one new ChatGPT conversation passed live acceptance at 16:30 UTC.
The second message contained a line break. Both received their own new answers
in Chrome and Paseo, followed by trace-matched protocol acknowledgements.

This is bounded acceptance. The deliberately ineffective second send is covered
by a packaged synthetic regression; it was not induced in ChatGPT. See the
[published acceptance record](evidence/20261025-head52-live.json) and the
[historical incident](INCIDENT-STALE-ANSWER.md).

## Installed identities and retained runtime

| Component | Source or immutable identity |
| --- | --- |
| Router source | `52a07ce6b476526c8dd9ee9a276f530b1f3b8607` |
| Router image | `sha256:71d5e66f83290dbe2162598d572913b23f0f0f2a5480b477f49662890e49b31e` |
| Native provider source | `52a07ce6b476526c8dd9ee9a276f530b1f3b8607` |
| Browser source, retained | `e04c76b0f607c9dbf145b648c38893e1a243857b` |
| Browser image, retained | `sha256:a36ac8dc2761da676ed9823559b4a5fdd9b0fbfd4dcb7d1c2b69ee1a2d9cc90b` |

Provider `codexpro-browser`, model `chatgpt`, is running in the existing Paseo.
The router reports a fresh shared `ready` heartbeat, zero restarts and no OOM.
Its network is the existing browser namespace, with no published ports and
restart policy `no`. Memory remains 1280/256 MiB and CPU 0.8/0.2 for browser/router.

- Viewer: http://192.168.11.241:6081/vnc.html?autoconnect=1&resize=scale
- Profile: `codexpro-reference_profile` at `/home/node/profile`.
- State: host `/opt/stacks/paseo-beta/paseo-home/.paseo/codexpro`, Paseo
  `/home/paseo/.paseo/codexpro`, router `/data` as its dedicated RW bind.
- Direct administration: `ssh codexpro-vm108` from Paseo. Mac and CT107 are not
  dependencies of this access route or the running bridge.

The browser container ID and its historical restart count of one were preserved.
Paseo was not restarted. Earlier manual login/viewer and country-only DE egress
checks are historical evidence; this rollout did not repeat or change them.
Login persistence across a browser restart remains unverified.

## Live acceptance and retained data

The operator authorized this exact candidate, one reversible queue quarantine
and two new messages without waiting for FirstMate. FirstMate's review attempt
ended at its account limit; an independent review is not claimed.

1. `Ответь ровно BRIDGE-CHECK-1` produced `BRIDGE-CHECK-1`.
2. `Ответь ровно BRIDGE-CHECK-2` followed by a second line,
   `Это проверка многострочного ввода.`, produced `BRIDGE-CHECK-2`.

Read-only inspection of the new test tab confirmed two user messages and two
assistant answers, one added turn identity for the second exchange, the same
Chrome target/conversation, an empty composer, and no visible stop/streaming.
Both task texts matched the requested prompts exactly, without Paseo delivery
metadata. The multiline text was intact. Each acknowledgement matched its own
trace and expected answer. Exactly two real messages were sent, with no retries.
No older failed or cancelled request was replayed.

The unresolved cancel-only item `20261025T120431Z-lcx5ms` was atomically moved
outside the runnable spool into `quarantine/<chat-key>/<turn-id>` under the
same state root. Its `task.json`, `alive` and `cancel` retained their hashes.
No artificial result/acknowledgement was created. All 107 files belonging to the
15 previously acknowledged tasks remained unchanged.

## Build and regression evidence

All 104 source-stage files matched exact Git blobs before building. The image's
revision label, 16 source hashes and five patched runtime files matched the
verified source. Nonroot validation read 1813 files, checked entrypoints and
loaded Node/Python dependencies. Actual Compose rendering included the opt-in
bridge profile and pinned the candidate by immutable ID.

Seventeen packaged submission/serialization regressions passed inside the new
image with no network, a read-only root filesystem and temporary test state.
Earlier exact-source checks remain: 106 reference tests, eight provider tests,
35 serial deployment tests, 12 focused driver tests and TypeScript. They were
not rerun merely to repeat a green result. TypeScript also passed in the exact
persistent provider stage before installation. The earlier parallel
`ALIVE_EXPIRED` and three pre-existing docs-marker failures remain recorded.
CI checks source smoke/synchronization, not this live acceptance.
The alternative all-in-Paseo packaging was not installed.

## Operator workflow and rollback

Within this operator-authorized task, routine reversible updates and the two
agreed tests proceed without repeated approval. The obsolete task-wide hold
was removed from the active brief. Submission/binding/cancel guards, educational
limits and challenge stops remain. This does not authorize additional unattended
messages or automatic replay after uncertain sending.

Before manual browsing or CAPTCHA, stop only the router on VM108:

```sh
docker stop codexpro-reference-bridge-1
```

After manual takeover, inspect the retained queue and explicitly resume:

```sh
docker start codexpro-reference-bridge-1
```

The provider rejects messages while the heartbeat is stale or stopped. Rollback
stops the candidate router, restores the prior immutable router image in a
stopped state and restores the prior local provider source. Keep the browser,
profile, histories and quarantine. Never automatically return the quarantined
item to a running queue or use `down -v`/prune.

Native plugin install rejects an already configured ID. Replacement removes
only its configuration before installing the exact staged directory under the
same ID; old and new source directories are retained. Paseo stays running.

Canonical records in `data/codexpro-deploy-20261024/` include
`head52-image-review-result.json`, `head52-rollout-packet.json`,
`head52-quarantine-result.json`, `head52-provider-native-replace-events.json`,
`head52-router-live.json`, `head52-live-acceptance-summary.json` and the guarded
apply/rollback scripts. Public evidence omits conversation URLs and private
message contents. Current instructions are in `brief.md`; old paused handoffs
remain historical records.
