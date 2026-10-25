#!/usr/bin/env node
// Read-only, deterministic discussion and entity planner. API bodies are kept in
// memory; output contains metadata and hashes only.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const markerRe = /^<!-- codexpro-discussion-sync:v1 origin=([^ ]+) source-sha256=([a-f0-9]{64}) actor=([A-Za-z0-9_.-]+) -->$/;
const markerMentionRe = /<!-- codexpro-discussion-sync:v1\b[^>]*-->/g;
const attachmentPattern = /(?:!\[[^\]]*\]\([^)]*\)|https?:\/\/[^\s)]+(?:\.png|\.jpe?g|\.gif|\.webp|\.mp4|\.mov)(?:\?[^\s)]*)?)/gi;
const MAX_PAGES = 100;
const COMMAND_TIMEOUT_MS = 20_000;

function stableOrigin(sourceService, objectKind, objectId, commentId, project) {
  const sourceProject = project ?? (sourceService === 'github' ? 'github.com/dinered/codexpro' : 'gitlab.home.arpa/ai-company/codexpro');
  return `${sourceProject}:${objectKind}:${objectId}:comment:${commentId}`;
}
function stableMarker(origin, bodySha256, actor) {
  return `<!-- codexpro-discussion-sync:v1 origin=${origin} source-sha256=${bodySha256} actor=${actor} -->`;
}
function renderMirror({ origin, body, actor, sourceService, sourceUrl, author, createdAt }) {
  const hash = createHash('sha256').update(body ?? '', 'utf8').digest('hex');
  const service = sourceService === 'github' ? 'GitHub' : 'GitLab';
  const safeMeta = (value) => String(value ?? 'unknown').replace(/[\r\n<>]/g, ' ');
  return `> Informational mirror from ${service}\n> Source: ${safeMeta(sourceUrl)}\n> Original author: ${safeMeta(author)}; created: ${safeMeta(createdAt)}\n\n${body ?? ''}\n\n${stableMarker(origin, hash, actor)}`;
}
function markerRecord(item, expectedActor) {
  const body = item.body ?? '';
  const matches = [...body.matchAll(new RegExp(markerMentionRe.source, 'g'))];
  if (!matches.length) return { state: 'none' };
  const finalLine = body.trimEnd().split('\n').at(-1);
  const parsed = markerRe.exec(finalLine ?? '');
  const actor = item.user?.login ?? item.author?.username ?? null;
  if (matches.length !== 1 || !parsed || actor !== parsed[3] || (expectedActor && actor !== expectedActor)) return { state: 'ambiguous' };
  const envelope = /^> Informational mirror from (GitHub|GitLab)\n> Source: https?:\/\/[^\n]+\n> Original author: [^\n]+; created: [^\n]+\n\n([\s\S]*)\n\n<!-- codexpro-discussion-sync:v1 origin=([^ ]+) source-sha256=([a-f0-9]{64}) actor=([A-Za-z0-9_.-]+) -->$/.exec(body);
  if (!envelope || envelope[3] !== parsed[1] || envelope[4] !== parsed[2] || envelope[5] !== parsed[3] || createHash('sha256').update(envelope[2], 'utf8').digest('hex') !== parsed[2]) return { state: 'ambiguous' };
  return { state: 'verified', origin: parsed[1], hash: parsed[2], actor };
}
function commentMetadata(item, sourceService, objectKind, objectId, sourceObjectUrl = null, project = null) {
  const body = item.body ?? '';
  const originId = stableOrigin(sourceService, objectKind, objectId, item.id, project);
  const bodySha256 = createHash('sha256').update(body, 'utf8').digest('hex');
  const actor = item.user ?? item.author ?? {};
  return {
    sourceCommentId: item.id, originId, bodySha256,
    author: actor.login ?? actor.username ?? null,
    createdAt: item.created_at ?? null, updatedAt: item.updated_at ?? null,
    edited: Boolean(item.updated_at && item.created_at && item.updated_at !== item.created_at),
    attachmentCount: [...body.matchAll(attachmentPattern)].length,
    sourceUrl: item.html_url ?? item.web_url ?? (sourceService === 'gitlab' && sourceObjectUrl ? `${sourceObjectUrl}#note_${item.id}` : null),
  };
}
function classifyExisting(items, origin, sourceHash, expectedActor) {
  let found = false;
  for (const item of items) {
    const rec = markerRecord(item, expectedActor);
    if (rec.state === 'ambiguous') {
      if ((item.body ?? '').includes('<!-- codexpro-discussion-sync:')) return 'manual_ambiguous_marker_review';
    }
    if (rec.state === 'verified' && rec.origin === origin) {
      found = true;
      if (rec.hash !== sourceHash) return 'manual_source_edit_review';
    }
  }
  return found ? 'already_mirrored' : null;
}
function addDirection(rows, opts) {
  const { sourceService, sourceObjectKind, sourceObjectId, sourceObjectUrl, sourceComments, targetService,
    targetComments, targetObjectUrl, sourceProject, targetActor, sourceActor } = opts;
  for (const item of sourceComments) {
    const ownMarker = markerRecord(item, sourceActor);
    const details = commentMetadata(item, sourceService, sourceObjectKind, sourceObjectId, sourceObjectUrl, sourceProject);
    let action;
    if (ownMarker.state === 'verified') action = 'source_is_mirror';
    else if (ownMarker.state === 'ambiguous') action = 'manual_ambiguous_marker_review';
    else action = classifyExisting(targetComments, details.originId, details.bodySha256, targetActor) ??
      (details.attachmentCount ? 'manual_attachment_review' : 'create_attributed_mirror');
    rows.push({ action, sourceService, targetService, sourceObjectKind, sourceObjectId, targetObjectUrl, ...details });
  }
}
function statusConflict(kind, githubNumber, githubState, gitlabIid, gitlabState, githubUrl, gitlabUrl, sourceCanonical = 'github') {
  if (gitlabState === 'opened') gitlabState = 'open';
  if (githubState === gitlabState) return null;
  return { action: 'status_copy_close_candidate', objectKind: kind, githubNumber, githubState, githubUrl, gitlabIid, gitlabState, gitlabUrl,
    proposedAction: 'close_stale_intake_copy_only_after provenance/body/no-independent-work verification', automaticMutation: false,
    sourceCanonical, proposedTarget: sourceCanonical === 'github' ? 'gitlab' : 'github' };
}
function githubThreadMetadata(comment) {
  return { reviewId: comment.pull_request_review_id ?? null, replyToId: comment.in_reply_to_id ?? null,
    filePath: comment.path ?? null, line: comment.line ?? comment.original_line ?? null, side: comment.side ?? comment.original_side ?? null };
}
function gitlabThreadMetadata(discussion, note) {
  return { threadId: discussion.id ?? null, replyToId: note.in_reply_to_id ?? null,
    resolvable: note.resolvable ?? false, resolved: discussion.resolved ?? false };
}
function makeCliApi({ githubCli = 'gh', gitlabCli = 'glab', request = null } = {}) {
  const getJson = (service, bin, endpoint) => request ? request(service, endpoint) : JSON.parse(execFileSync(bin, ['api', endpoint, '--hostname', service === 'github' ? 'github.com' : 'gitlab.home.arpa'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: COMMAND_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 }));
  return {
    github: (path) => getJson('github', githubCli, `repos/dinered/codexpro/${path.replace(/^\//, '')}`),
    gitlab: (path) => getJson('gitlab', gitlabCli, `projects/27/${path.replace(/^\//, '')}`),
    pages(service, path) {
      const fetch = service === 'github' ? this.github : this.gitlab;
      const result = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const query = `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`;
        const batch = fetch(query);
        if (!Array.isArray(batch)) throw new TypeError(`Expected ${service} collection response`);
        result.push(...batch);
        if (batch.length < 100) return result;
      }
      throw new Error(`Page limit exceeded for ${service} collection`);
    },
  };
}
function planEntityCoverage(api, mapping, rows) {
  const ghIssues = api.pages('github', 'issues?state=all').filter((x) => !x.pull_request);
  const ghPrs = api.pages('github', 'pulls?state=all');
  const glIssues = api.pages('gitlab', 'issues?state=all');
  const glMrs = api.pages('gitlab', 'merge_requests?state=all');
  const mappedGhIssue = new Set(mapping.issues.map((x) => x.githubNumber).concat(mapping.gitlabOnlyIssue.githubNumber));
  const mappedGlIssue = new Set(mapping.issues.map((x) => x.gitlabIid).concat(mapping.gitlabOnlyIssue.gitlabIid));
  const mappedGhPr = new Set(mapping.pullRequests.map((x) => x.githubNumber));
  const mappedGlMr = new Set(mapping.pullRequests.map((x) => x.gitlabIid));
  const ghUnmappedIssues = ghIssues.filter((x) => !mappedGhIssue.has(x.number));
  const glUnmappedIssues = glIssues.filter((x) => !mappedGlIssue.has(x.iid));
  const ghUnmappedPrs = ghPrs.filter((x) => !mappedGhPr.has(x.number));
  const glUnmappedMrs = glMrs.filter((x) => !mappedGlMr.has(x.iid));
  const entityRow = (service, kind, source, url, plan) => rows.push({ action: 'unmapped_entity_counterpart_review', sourceService: service, sourceKind: kind, sourceId: service === 'github' ? source.number : source.iid, sourceState: source.merged_at ? 'merged' : source.state, sourceUrl: url, sourceTitle: source.title, titleSha256: createHash('sha256').update(source.title ?? '').digest('hex'), counterpartPlan: plan });
  for (const source of ghUnmappedIssues) entityRow('github', 'issue', source, source.html_url, 'create attributed GitLab informational issue unless a verified existing counterpart is identified');
  for (const source of glUnmappedIssues) entityRow('gitlab', 'issue', source, source.web_url, 'create attributed GitHub informational issue unless a verified existing counterpart is identified');
  for (const source of ghUnmappedPrs) entityRow('github', 'pull_request', source, source.html_url, source.merged_at ? 'create attributed GitLab informational record; no native merged MR; known omnibus/contextual MRs excluded' : 'propose native GitLab MR using corresponding refs if available');
  for (const source of glUnmappedMrs) entityRow('gitlab', 'merge_request', source, source.web_url, source.state === 'opened' ? 'propose native GitHub PR using corresponding refs if available' : 'create attributed GitHub informational record; do not claim a native merged PR or replay review votes');
  const addUnmappedComment = (service, kind, object, item, targetService, targetUrl) => rows.push({ action: 'unmapped_discussion_counterpart_review', sourceService: service, targetService, sourceObjectKind: kind, sourceObjectId: service === 'github' ? object.number : object.iid,
    sourceCommentId: item.id, sourceUrl: item.html_url ?? item.web_url ?? null, targetObjectUrl: targetUrl ?? null, ...commentMetadata(item, service, kind, service === 'github' ? object.number : object.iid, object.html_url ?? object.web_url, service === 'github' ? 'github.com/dinered/codexpro' : 'gitlab.home.arpa/ai-company/codexpro'),
    informationalOnly: true, automaticVote: false });
  for (const source of ghUnmappedIssues) for (const item of api.pages('github', `issues/${source.number}/comments`)) addUnmappedComment('github', 'github-issue', source, item, 'gitlab', null);
  for (const source of glUnmappedIssues) for (const item of api.pages('gitlab', `issues/${source.iid}/notes?activity_filter=only_comments`)) if (!item.system) addUnmappedComment('gitlab', 'gitlab-issue', source, item, 'github', null);
  for (const source of ghUnmappedPrs) {
    for (const item of api.pages('github', `issues/${source.number}/comments`)) addUnmappedComment('github', 'github-pr', source, item, 'gitlab', null);
    for (const review of api.pages('github', `pulls/${source.number}/reviews`)) rows.push({ action: 'unmapped_review_history_counterpart_review', sourceService: 'github', sourceObjectKind: 'github-pr', sourceObjectId: source.number, sourceReviewId: review.id, reviewState: review.state, author: review.user?.login ?? null, submittedAt: review.submitted_at ?? null, sourceUrl: source.html_url, automaticVote: false });
    for (const item of api.pages('github', `pulls/${source.number}/comments`)) rows.push({ action: 'unmapped_discussion_counterpart_review', sourceService: 'github', sourceObjectKind: 'github-pr-inline', sourceObjectId: source.number, ...commentMetadata(item, 'github', 'github-pr', source.number, source.html_url, 'github.com/dinered/codexpro'), ...githubThreadMetadata(item), informationalOnly: true, automaticVote: false });
  }
  for (const source of glUnmappedMrs) {
    const allNotes = api.pages('gitlab', `merge_requests/${source.iid}/notes?activity_filter=only_comments`).filter((n) => !n.system);
    const discussions = api.pages('gitlab', `merge_requests/${source.iid}/discussions`);
    const inlineIds = new Set(discussions.flatMap((d) => d.notes ?? []).filter((n) => !n.system && n.position).map((n) => String(n.id)));
    for (const item of allNotes.filter((n) => !inlineIds.has(String(n.id)))) addUnmappedComment('gitlab', 'gitlab-mr', source, item, 'github', null);
    for (const discussion of discussions) for (const note of discussion.notes ?? []) if (!note.system && note.position) rows.push({ action: 'unmapped_discussion_counterpart_review', sourceService: 'gitlab', sourceObjectKind: 'gitlab-mr-inline', sourceObjectId: source.iid, ...commentMetadata(note, 'gitlab', 'gitlab-mr', source.iid, source.web_url, 'gitlab.home.arpa/ai-company/codexpro'), ...gitlabThreadMetadata(discussion, note), informationalOnly: true, automaticVote: false });
    const approvals = api.gitlab(`merge_requests/${source.iid}/approvals`);
    for (const entry of approvals.approved_by ?? []) rows.push({ action: 'unmapped_review_history_counterpart_review', sourceService: 'gitlab', sourceObjectKind: 'gitlab-mr', sourceObjectId: source.iid, reviewState: 'approved_at_read_time', author: entry.user?.username ?? null, submittedAt: null, sourceUrl: source.web_url, automaticVote: false });
  }
  return { githubIssues: ghIssues.length, githubPullRequests: ghPrs.length, gitlabIssues: glIssues.length, gitlabMergeRequests: glMrs.length };
}
function buildPlan(api, mapping, actors = {}) {
  const rows = [];
  const glProject = 'gitlab.home.arpa/ai-company/codexpro';
  const ghProject = 'github.com/dinered/codexpro';
  const addPair = (kind, ghNumber, glIid, ghObject, glObject, ghComments, glNotes, sourceCanonical = 'github') => {
    const status = statusConflict(kind, ghNumber, kind === 'issue' ? ghObject.state : ghObject.merged_at ? 'merged' : ghObject.state,
      glIid, glObject.state === 'opened' ? 'open' : glObject.state, ghObject.html_url, glObject.web_url, sourceCanonical);
    if (status) rows.push(status);
    const ghKind = kind === 'issue' ? 'github-issue' : 'github-pr';
    const glKind = kind === 'issue' ? 'gitlab-issue' : 'gitlab-mr';
    addDirection(rows, { sourceService: 'github', sourceObjectKind: ghKind, sourceObjectId: ghNumber, sourceObjectUrl: ghObject.html_url,
      sourceComments: ghComments, sourceProject: ghProject, targetService: 'gitlab', targetComments: glNotes, targetObjectUrl: glObject.web_url, targetActor: actors.gitlab, sourceActor: actors.github });
    addDirection(rows, { sourceService: 'gitlab', sourceObjectKind: glKind, sourceObjectId: glIid, sourceObjectUrl: glObject.web_url,
      sourceComments: glNotes, sourceProject: glProject, targetService: 'github', targetComments: ghComments, targetObjectUrl: ghObject.html_url, targetActor: actors.github, sourceActor: actors.gitlab });
  };
  for (const pair of mapping.issues) {
    const gh = api.github(`issues/${pair.githubNumber}`); const gl = api.gitlab(`issues/${pair.gitlabIid}`);
    addPair('issue', pair.githubNumber, pair.gitlabIid, gh, gl, api.pages('github', `issues/${pair.githubNumber}/comments`), api.pages('gitlab', `issues/${pair.gitlabIid}/notes?activity_filter=only_comments`));
  }
  for (const pair of mapping.pullRequests) {
    const gh = api.github(`pulls/${pair.githubNumber}`); const gl = api.gitlab(`merge_requests/${pair.gitlabIid}`);
    const ghComments = api.pages('github', `issues/${pair.githubNumber}/comments`);
    const ghReviews = api.pages('github', `pulls/${pair.githubNumber}/reviews`);
    const ghInline = api.pages('github', `pulls/${pair.githubNumber}/comments`);
    const glNotes = api.pages('gitlab', `merge_requests/${pair.gitlabIid}/notes?activity_filter=only_comments`);
    const glDiscussions = api.pages('gitlab', `merge_requests/${pair.gitlabIid}/discussions`);
    // Inline notes are represented only by discussions; remove those IDs from
    // the ordinary-note collection so every GitLab note is planned once.
    const inlineIds = new Set(glDiscussions.flatMap((d) => d.notes ?? []).filter((n) => !n.system && n.position).map((n) => String(n.id)));
    const ordinary = glNotes.filter((n) => !inlineIds.has(String(n.id)));
    addPair('pull_request', pair.githubNumber, pair.gitlabIid, gh, gl, ghComments, ordinary);
    for (const review of ghReviews) rows.push({ action: 'manual_review_history', sourceService: 'github', sourceObjectKind: 'github-pr', sourceObjectId: pair.githubNumber,
      sourceReviewId: review.id, reviewState: review.state, author: review.user?.login ?? null, submittedAt: review.submitted_at ?? null, targetObjectUrl: gl.web_url, automaticVote: false });
    const glApprovals = api.gitlab(`merge_requests/${pair.gitlabIid}/approvals`);
    for (const entry of glApprovals.approved_by ?? []) rows.push({ action: 'manual_review_history', sourceService: 'gitlab', sourceObjectKind: 'gitlab-mr', sourceObjectId: pair.gitlabIid,
      reviewState: 'approved_at_read_time', author: entry.user?.username ?? null, submittedAt: null, targetObjectUrl: gh.html_url, automaticVote: false });
    for (const comment of ghInline) rows.push({ action: 'manual_inline_thread_review', sourceService: 'github', ...commentMetadata(comment, 'github', 'github-pr', pair.githubNumber, gh.html_url, ghProject),
      ...githubThreadMetadata(comment), sourceObjectId: pair.githubNumber, targetObjectUrl: gl.web_url, automaticVote: false });
    for (const discussion of glDiscussions) for (const note of discussion.notes ?? []) {
      if (note.system || !note.position) continue;
      rows.push({ action: 'manual_inline_thread_review', sourceService: 'gitlab', ...commentMetadata(note, 'gitlab', 'gitlab-mr', pair.gitlabIid, gl.web_url, glProject),
        ...gitlabThreadMetadata(discussion, note), sourceObjectId: pair.gitlabIid, targetObjectUrl: gh.html_url, automaticVote: false });
    }
  }
  const rev = mapping.gitlabOnlyIssue;
  const gh = api.github(`issues/${rev.githubNumber}`); const gl = api.gitlab(`issues/${rev.gitlabIid}`);
  addPair('issue', rev.githubNumber, rev.gitlabIid, gh, gl, api.pages('github', `issues/${rev.githubNumber}/comments`), api.pages('gitlab', `issues/${rev.gitlabIid}/notes?activity_filter=only_comments`), 'gitlab');
  const inventory = planEntityCoverage(api, mapping, rows);
  rows.sort((a, b) => { const left = JSON.stringify([a.action, a.sourceService ?? '', a.sourceObjectKind ?? a.sourceKind ?? a.objectKind ?? '', String(a.sourceObjectId ?? a.sourceId ?? a.githubNumber ?? ''), String(a.sourceCommentId ?? a.sourceReviewId ?? '')]); const right = JSON.stringify([b.action, b.sourceService ?? '', b.sourceObjectKind ?? b.sourceKind ?? b.objectKind ?? '', String(b.sourceObjectId ?? b.sourceId ?? b.githubNumber ?? ''), String(b.sourceCommentId ?? b.sourceReviewId ?? '')]); return left < right ? -1 : left > right ? 1 : 0; });
  const summary = Object.fromEntries([...rows.reduce((m, r) => m.set(r.action, (m.get(r.action) ?? 0) + 1), new Map())]);
  return { schemaVersion: 2, readOnly: true, githubRepository: mapping.githubRepository, gitlabProjectId: mapping.gitlabProjectId,
    gitlabProject: glProject, inventory, summary, excluded: mapping.excluded ?? [], rows };
}
function main() {
  const args = process.argv.slice(2); const value = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback; };
  try {
    const mapping = JSON.parse(readFileSync(resolve(value('--mapping', resolve(here, 'mappings.json'))), 'utf8'));
    const api = makeCliApi({ githubCli: value('--github-cli', process.env.GH_CLI ?? 'gh'), gitlabCli: value('--gitlab-cli', process.env.GLAB_CLI ?? 'glab') });
    const actors = { github: JSON.parse(execFileSync(value('--github-cli', process.env.GH_CLI ?? 'gh'), ['api', 'user', '--hostname', 'github.com'], { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS })).login,
      gitlab: JSON.parse(execFileSync(value('--gitlab-cli', process.env.GLAB_CLI ?? 'glab'), ['api', 'user', '--hostname', 'gitlab.home.arpa'], { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS })).username };
    process.stdout.write(`${JSON.stringify(buildPlan(api, mapping, actors), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`discussion-sync plan failed (${error?.name ?? 'Error'}); no remote writes attempted\n`); process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
export { addDirection, buildPlan, commentMetadata, gitlabThreadMetadata, githubThreadMetadata, makeCliApi, markerRecord, renderMirror, stableMarker, stableOrigin, statusConflict };
