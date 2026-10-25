import test from 'node:test';
import assert from 'node:assert/strict';
import { addDirection, commentMetadata, parseMarkerIds, stableMarker, statusConflict } from './plan.mjs';

test('stable markers identify one source record and hashes keep body text out of plan', () => {
  const row = commentMetadata({ id: 31, body: 'private text', created_at: 'same', updated_at: 'same', user: { login: 'author' } }, 'github', 'github-issue', 7);
  assert.equal(row.originMarker, stableMarker('github:github-issue:7:comment:31', row.bodySha256));
  assert.equal(row.bodySha256.length, 64);
  assert.equal(JSON.stringify(row).includes('private text'), false);
});

test('a marker already at the target makes reruns idempotent', () => {
  const source = { id: 31, body: 'hello', created_at: 'same', updated_at: 'same' };
  const row = commentMetadata(source, 'github', 'github-issue', 7);
  const target = { id: 52, body: row.originMarker };
  assert.deepEqual([...parseMarkerIds([target])], [['github:github-issue:7:comment:31', row.bodySha256]]);
  const rows = [];
  addDirection(rows, { sourceService: 'github', sourceObjectKind: 'github-issue', sourceObjectId: 7,
    sourceComments: [source], targetService: 'gitlab', targetComments: [target], targetObjectUrl: 'target' });
  assert.equal(rows[0].action, 'already_mirrored');
});

test('an edited source becomes a review row and an old unversioned marker is not silently accepted', () => {
  const old = commentMetadata({ id: 31, body: 'old', created_at: 't', updated_at: 't' }, 'github', 'github-issue', 7);
  const current = { id: 31, body: 'new', created_at: 't', updated_at: 'later' };
  const rows = [];
  addDirection(rows, { sourceService: 'github', sourceObjectKind: 'github-issue', sourceObjectId: 7,
    sourceComments: [current], targetService: 'gitlab', targetComments: [{ body: old.originMarker }], targetObjectUrl: 'target' });
  assert.equal(rows[0].action, 'manual_source_edit_review');
  const legacyRows = [];
  addDirection(legacyRows, { sourceService: 'github', sourceObjectKind: 'github-issue', sourceObjectId: 7,
    sourceComments: [current], targetService: 'gitlab', targetComments: [{ body: stableMarker('github:github-issue:7:comment:31') }], targetObjectUrl: 'target' });
  assert.equal(legacyRows[0].action, 'manual_legacy_marker_review');
});

test('attachments are withheld for human review and edits are visible without destructive overwrite', () => {
  const source = { id: 2, body: 'see ![img](https://example.test/a.png)', created_at: 't1', updated_at: 't2' };
  const rows = [];
  addDirection(rows, { sourceService: 'github', sourceObjectKind: 'github-pr', sourceObjectId: 8,
    sourceComments: [source], targetService: 'gitlab', targetComments: [], targetObjectUrl: 'target' });
  assert.equal(rows[0].action, 'manual_attachment_review');
  assert.equal(rows[0].attachmentCount, 1);
  assert.equal(rows[0].edited, true);
});

test('status differences are review rows and never mutate either object', () => {
  const row = statusConflict('issue', 1, 'closed', 8, 'opened', 'github-url', 'gitlab-url');
  assert.equal(row.action, 'status_conflict_review');
  assert.equal(row.automaticMutation, false);
  assert.equal(statusConflict('issue', 1, 'closed', 8, 'closed', 'gh', 'gl'), null);
  assert.equal(statusConflict('issue', 11, 'open', 7, 'opened', 'gh', 'gl'), null);
});
