# Unconfirmed submission returned the previous answer — 2026-10-24

Status: correction deployed from `52a07ce`; two consecutive native messages,
including multiline input, passed live acceptance on 2026-10-25. Follow-up:
[issue #7](http://gitlab.home.arpa/ai-company/codexpro/-/work_items/7).
The deployment from [MR !9](http://gitlab.home.arpa/ai-company/codexpro/-/merge_requests/9)
is merged. Its historical failure below is retained; current identities and
bounded acceptance evidence are in [DEPLOYMENT-STATUS.md](DEPLOYMENT-STATUS.md).

## What was observed

At 19:59:16 UTC a read-only check inspected the same bound working-chat target
and conversation. It compared task text with the composer and user bubbles,
and compared acknowledgements with the last assistant answer. The published
evidence contains match flags, counts, lengths and times, without private
message contents or conversation URLs.

| Turn time (UTC) | Platform user bubble | Observation |
| --- | --- | --- |
| 19:41:52 | Present | Authorized single-turn acceptance completed in Paseo. |
| 19:55:42 | Present | A later user message has a matching bubble and assistant reply. |
| 19:56:10 | Absent | Its nine-character text remains in the composer, but Paseo acknowledged success with the preceding 15-character answer. |
| 19:57:12 | Absent | Cancelled turn retained; no replay performed. |

The DOM contained two user bubbles and two assistant nodes. The third turn's
acknowledgement matched the second turn's acknowledgement and the last assistant
answer. The executing driver reported `busy: false`, `sendIdle: true`; the
composer was nonempty, Send was visible and enabled, and Voice/Stop/streaming
indicators were absent.

The prior single-turn check remains valid for that one turn. Its `idle` state
and protocol acknowledgement were insufficient grounds for claiming the whole
conversation workflow worked.

## Cause and uncertainty

Stale-answer reuse is confirmed: a newly acknowledged turn returned an existing
answer while its user message was still a draft and absent from the observed
platform history. The driver presses Enter without confirming a new user turn;
answer polling reads the latest assistant DOM without a baseline for the current
submission. The enabled Send path can establish idle while a draft remains.

The reason Enter did not submit is unknown. Composer focus at observation time
does not establish focus at keypress time. No failure-time network trace was
captured; the absence of a user bubble does not establish whether the platform
received any network request. No real resend or manual result substitution was
used in diagnosis.

## Required regression and acceptance

- Two distinct consecutive synthetic prompts, with the second submission
  deliberately ineffective: the second turn must never publish the prior answer.
- A successful control accepts both prompts and attributes each answer to its
  own new user turn. Identical answer text across different turns must remain
  valid; text inequality alone is insufficient proof of a new answer.
- Preserve binding, origin, target, conversation exclusivity, cancellation,
  stable-answer and busy/streaming checks. Ambiguous sending must fail explicitly
  without an automatic replay or a fabricated result.
- Review the bounded implementation, regression results and exact immutable
  image/configuration packet before replacing the router. A passing regression
  or CI alone does not prove the correction is running.

## Runtime and retained evidence

Historical router source: `d928d7a0b9c546a9862601437a634ee2a0df630a`.
Historical image: `sha256:e4bbe3a1ea90904acb00ee41a61271bd1258dd25508eb98a1f318131de25d345`.
MR !9 merge: `310f926b9c8ec8cf2389480ca12b4595b0093e7a`.
This documentation does not replace the running image.

The installed correction requires a newly accepted user turn and its next new
assistant turn; uncertain sending fails without resend. Its packaged regression
deliberately leaves the second message unsent and refuses the old answer. Two
authorized real messages produced distinct expected answers in the same Chrome
conversation and in Paseo. Multiline task text, DOM identities and trace-matched
acknowledgements were checked. The live check did not deliberately induce an
ineffective Enter; see [the acceptance record](evidence/20261025-head52-live.json).

Canonical records under `data/codexpro-deploy-20261024/` include
`consecutive-send-dom-evidence.json`, `live-acceptance-voice-idle.json`,
`live-acceptance-voice-idle-protocol.json`, the exact reviewed image/apply packet
and preserved task/ack/cancel/journal snapshots. Browser, profile, failed turns
and paused packaging work remain preserved.

General agent-message metadata filtering stays separate in
[issue #6](http://gitlab.home.arpa/ai-company/codexpro/-/work_items/6).
Live testing is tracked in
[issue #3](http://gitlab.home.arpa/ai-company/codexpro/-/work_items/3).
