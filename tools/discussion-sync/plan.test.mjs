import test from 'node:test';
import assert from 'node:assert/strict';
import { addDirection, buildPlan, commentMetadata, gitlabThreadMetadata, githubThreadMetadata, makeCliApi, markerRecord, renderMirror, stableMarker, stableOrigin, statusConflict } from './plan.mjs';

const actors = { github: 'sync-gh', gitlab: 'sync-gl' };
const ghProject = 'github.com/dinered/codexpro';
const glProject = 'gitlab.home.arpa/ai-company/codexpro';
function source(body='hello', id=31) { return { id, body, created_at: '2026-10-25T01:00:00Z', updated_at: '2026-10-25T01:00:00Z', user: { login: 'author' } }; }
function mirror(origin, hash, actor, original='hello') { return { id: 52, body: renderMirror({ origin, body: original, actor, sourceService: 'github', sourceUrl: 'https://github.com/dinered/codexpro/issues/7#issuecomment-31', author: 'author', createdAt: '2026-10-25T01:00:00Z' }), author: { username: actor } }; }

test('stable origin binds service, full project, object, comment and body hash', () => {
  const row = commentMetadata(source('private text'), 'github', 'github-issue', 7, null, ghProject);
  assert.equal(row.originId, 'github.com/dinered/codexpro:github-issue:7:comment:31');
  assert.equal(row.bodySha256.length, 64);
  assert.equal(JSON.stringify(row).includes('private text'), false);
  assert.notEqual(stableOrigin('gitlab', 'gitlab-issue', 7, 31, glProject), stableOrigin('github', 'github-issue', 7, 31, ghProject));
});

test('two directional passes recognize the generated mirror and do not echo it back', () => {
  const original = source();
  const meta = commentMetadata(original, 'github', 'github-issue', 7, null, ghProject);
  const copied = mirror(meta.originId, meta.bodySha256, actors.gitlab);
  const first = [];
  addDirection(first, { sourceService: 'github', sourceObjectKind: 'github-issue', sourceObjectId: 7, sourceProject: ghProject,
    sourceComments: [original], targetService: 'gitlab', targetComments: [], targetActor: actors.gitlab, sourceActor: actors.github });
  assert.equal(first[0].action, 'create_attributed_mirror');
  const reverse = [];
  addDirection(reverse, { sourceService: 'gitlab', sourceObjectKind: 'gitlab-issue', sourceObjectId: 8, sourceProject: glProject,
    sourceComments: [copied], targetService: 'github', targetComments: [], targetActor: actors.github, sourceActor: actors.gitlab });
  assert.equal(reverse[0].action, 'source_is_mirror');
  const rerun = [];
  addDirection(rerun, { sourceService: 'github', sourceObjectKind: 'github-issue', sourceObjectId: 7, sourceProject: ghProject,
    sourceComments: [original], targetService: 'gitlab', targetComments: [copied], targetActor: actors.gitlab, sourceActor: actors.github });
  assert.equal(rerun[0].action, 'already_mirrored');
});

test('partial failure after create is idempotent; body changes and target edits become conflicts', () => {
  const original = source(); const meta = commentMetadata(original, 'github', 'github-issue', 7, null, ghProject);
  const copied = mirror(meta.originId, meta.bodySha256, actors.gitlab);
  const rerun = [];
  addDirection(rerun, { sourceService: 'github', sourceObjectKind: 'github-issue', sourceObjectId: 7, sourceProject: ghProject,
    sourceComments: [original], targetService: 'gitlab', targetComments: [copied], targetActor: actors.gitlab, sourceActor: actors.github });
  assert.equal(rerun[0].action, 'already_mirrored');
  const editedSource = [];
  addDirection(editedSource, { sourceService: 'github', sourceObjectKind: 'github-issue', sourceObjectId: 7, sourceProject: ghProject,
    sourceComments: [source('new text')], targetService: 'gitlab', targetComments: [copied], targetActor: actors.gitlab, sourceActor: actors.github });
  assert.equal(editedSource[0].action, 'manual_source_edit_review');
  const editedTarget = { ...copied, body: `${copied.body}\nchanged` };
  const conflict = [];
  addDirection(conflict, { sourceService: 'github', sourceObjectKind: 'github-issue', sourceObjectId: 7, sourceProject: ghProject,
    sourceComments: [original], targetService: 'gitlab', targetComments: [editedTarget], targetActor: actors.gitlab, sourceActor: actors.github });
  assert.equal(conflict[0].action, 'manual_ambiguous_marker_review');
});

test('embedded, quoted, wrong-actor and malformed markers are ambiguous, never provenance', () => {
  const meta = commentMetadata(source(), 'github', 'github-issue', 7, null, ghProject);
  const marker = stableMarker(meta.originId, meta.bodySha256, actors.gitlab);
  for (const item of [
    { body: `quoted: ${marker}`, author: { username: actors.gitlab } },
    { body: `${marker}\nextra`, author: { username: actors.gitlab } },
    { body: marker, author: { username: 'other' } },
    { body: marker, author: { username: actors.gitlab } }, // wrong origin object for this source platform is still not accepted as source identity
  ]) {
    const result = markerRecord(item, actors.github);
    assert.equal(result.state, 'ambiguous');
  }
  const plan = [];
  addDirection(plan, { sourceService: 'github', sourceObjectKind: 'github-issue', sourceObjectId: 7, sourceProject: ghProject,
    sourceComments: [{ ...source(), body: `someone quoted ${marker}` }], targetService: 'gitlab', targetComments: [], targetActor: actors.gitlab, sourceActor: actors.github });
  assert.equal(plan[0].action, 'manual_ambiguous_marker_review');
});

test('exact generated envelope is recognized only under the platform sync actor', () => {
  const meta = commentMetadata(source(), 'github', 'github-issue', 7, null, ghProject);
  assert.equal(markerRecord(mirror(meta.originId, meta.bodySha256, actors.gitlab), actors.gitlab).state, 'verified');
  assert.equal(markerRecord(mirror(meta.originId, meta.bodySha256, actors.gitlab), 'unexpected').state, 'ambiguous');
});

test('attachments are held for manual review and source edit metadata is visible', () => {
  const item = { ...source('![image](https://example.test/a.png)'), updated_at: 'later' };
  const rows = [];
  addDirection(rows, { sourceService: 'github', sourceObjectKind: 'github-pr', sourceObjectId: 8, sourceProject: ghProject,
    sourceComments: [item], targetService: 'gitlab', targetComments: [], targetObjectUrl: 'target', targetActor: actors.gitlab, sourceActor: actors.github });
  assert.equal(rows[0].action, 'manual_attachment_review');
  assert.equal(rows[0].attachmentCount, 1);
  assert.equal(rows[0].edited, true);
});

test('status and inline metadata are retained without casting a vote', () => {
  const row = statusConflict('issue', 1, 'closed', 8, 'opened', 'gh', 'gl');
  assert.equal(row.action, 'status_copy_close_candidate'); assert.equal(row.automaticMutation, false);
  assert.equal(statusConflict('issue', 1, 'closed', 8, 'closed', 'gh', 'gl'), null);
  assert.deepEqual(githubThreadMetadata({ pull_request_review_id: 8, in_reply_to_id: 7, path: 'src/a.js', line: 4, side: 'RIGHT' }), { reviewId: 8, replyToId: 7, filePath: 'src/a.js', line: 4, side: 'RIGHT' });
  assert.deepEqual(gitlabThreadMetadata({ id: 'thread-1', resolved: true }, { in_reply_to_id: 4, resolvable: true }), { threadId: 'thread-1', replyToId: 4, resolvable: true, resolved: true });
});

test('planner inventories every unmapped object, including PR10 and GitLab-only objects', () => {
  const api = {
    github(path) {
      if (path.startsWith('issues/')) return { number: Number(path.split('/')[1]), state: 'closed', html_url: `https://github.com/i/${path}` };
      if (path.startsWith('pulls/')) return { number: Number(path.split('/')[1]), state: 'closed', merged_at: 't', html_url: `https://github.com/p/${path}` };
      throw Error(path);
    },
    gitlab(path) {
      if (path.startsWith('issues/')) return { iid: Number(path.split('/')[1]), state: 'opened', web_url: `https://gitlab.home.arpa/i/${path}` };
      if (path.startsWith('merge_requests/')) return { iid: Number(path.split('/')[1]), state: 'merged', web_url: `https://gitlab.home.arpa/m/${path}` };
      throw Error(path);
    },
    pages(service, path) {
      if (path.startsWith('issues?state=all')) return service === 'github' ? [{ number: 1, state: 'closed', html_url: 'gh1' }, { number: 11, state: 'open', html_url: 'gh11' }] : [{ iid: 7, state: 'opened', web_url: 'gl7' }, { iid: 8, state: 'opened', web_url: 'gl8' }, { iid: 15, state: 'opened', web_url: 'gl15' }];
      if (path.startsWith('pulls?state=all')) return [{ number: 8, state: 'closed', merged_at: 't', html_url: 'gh8' }, { number: 10, state: 'closed', merged_at: 't', html_url: 'gh10' }];
      if (path.startsWith('merge_requests?state=all')) return [{ iid: 12, state: 'opened', web_url: 'gl12' }, { iid: 15, state: 'merged', web_url: 'gl15' }, { iid: 16, state: 'opened', web_url: 'gl16' }];
      return [];
    },
  };
  const mapping = { githubRepository: 'dinered/codexpro', gitlabProjectId: 27, issues: [{ githubNumber: 1, gitlabIid: 8 }], pullRequests: [{ githubNumber: 8, gitlabIid: 12 }], gitlabOnlyIssue: { gitlabIid: 7, githubNumber: 11 } };
  const plan = buildPlan(api, mapping, actors);
  assert.deepEqual(plan.inventory, { githubIssues: 2, githubPullRequests: 2, gitlabIssues: 3, gitlabMergeRequests: 3 });
  const rows = plan.rows.filter((x) => x.action === 'unmapped_entity_counterpart_review');
  assert(rows.some((x) => x.sourceService === 'github' && x.sourceKind === 'pull_request' && x.sourceId === 10));
  assert(rows.some((x) => x.sourceService === 'gitlab' && x.sourceKind === 'merge_request' && x.sourceId === 15));
  assert(rows.some((x) => x.sourceService === 'gitlab' && x.sourceKind === 'issue' && x.sourceId === 15));
  assert(!rows.some((x) => x.sourceId === 10 && x.counterpartPlan?.includes('15')));
});

test('bounded pagination includes nested discussion notes and stops at the page cap', () => {
  const request = (_service, endpoint) => {
    const url = new URL(`https://api.invalid/${endpoint}`);
    const page = Number(url.searchParams.get('page') ?? 1);
    if (url.pathname.endsWith('/discussions')) return page === 1 ? [{ id: 'd1', notes: [{ id: 1 }, { id: 2 }] }, ...Array.from({ length: 99 }, (_, i) => ({ id: `d${i + 2}`, notes: [] }))] : [{ id: 'd101', notes: [{ id: 101 }] }];
    return [];
  };
  const api = makeCliApi({ request });
  const discussions = api.pages('gitlab', 'projects/27/merge_requests/1/discussions');
  assert.equal(discussions.length, 101);
  assert.deepEqual(discussions.flatMap((d) => d.notes ?? []).map((n) => n.id), [1, 2, 101]);
  const capped = makeCliApi({ request: (_service, endpoint) => {
    if (endpoint.includes('page=')) return Array(100).fill({});
    return [];
  } });
  assert.throws(() => capped.pages('gitlab', 'merge_requests/1/discussions'), /Page limit exceeded/);
});
