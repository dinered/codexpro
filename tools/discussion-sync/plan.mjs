#!/usr/bin/env node
// Read-only row-level planner. API response bodies remain in memory and are
// never printed; only stable IDs, attribution metadata and hashes are emitted.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const markerPattern = /<!-- codexpro-discussion-sync:v1 ([^ ]+)(?: source-sha256=([a-f0-9]{64}))? -->/g;
const attachmentPattern = /(?:!\[[^\]]*\]\([^)]*\)|https?:\/\/[^\s)]+(?:\.png|\.jpe?g|\.gif|\.webp|\.mp4|\.mov)(?:\?[^\s)]*)?)/gi;

function stableMarker(origin, bodySha256 = null) {
  return `<!-- codexpro-discussion-sync:v1 ${origin}${bodySha256 ? ` source-sha256=${bodySha256}` : ''} -->`;
}

function parseMarkerIds(items) {
  const result = new Map();
  for (const item of items) {
    for (const match of (item.body ?? '').matchAll(markerPattern)) result.set(match[1], match[2] ?? null);
  }
  return result;
}

function commentMetadata(item, sourceService, objectKind, objectId, sourceObjectUrl = null) {
  const body = item.body ?? '';
  const originId = `${sourceService}:${objectKind}:${objectId}:comment:${item.id}`;
  const bodySha256 = createHash('sha256').update(body, 'utf8').digest('hex');
  const actor = item.user ?? item.author ?? {};
  return {
    sourceCommentId: item.id,
    originMarker: stableMarker(originId, bodySha256),
    author: actor.login ?? actor.username ?? null,
    createdAt: item.created_at ?? null,
    updatedAt: item.updated_at ?? null,
    edited: Boolean(item.updated_at && item.created_at && item.updated_at !== item.created_at),
    bodySha256,
    attachmentCount: [...body.matchAll(attachmentPattern)].length,
    sourceUrl: item.html_url ?? item.web_url ?? (sourceService === 'gitlab' && sourceObjectUrl ? `${sourceObjectUrl}#note_${item.id}` : null),
  };
}

function addDirection(rows, { sourceService, sourceObjectKind, sourceObjectId, sourceObjectUrl, sourceComments, targetService, targetComments, targetObjectUrl }) {
  const targetMarkers = parseMarkerIds(targetComments);
  for (const item of sourceComments) {
    const details = commentMetadata(item, sourceService, sourceObjectKind, sourceObjectId, sourceObjectUrl);
    const origin = [...details.originMarker.matchAll(markerPattern)][0][1];
    let action = 'create_attributed_mirror';
    if (targetMarkers.has(origin)) {
      const mirroredHash = targetMarkers.get(origin);
      action = mirroredHash === details.bodySha256 ? 'already_mirrored' : mirroredHash ? 'manual_source_edit_review' : 'manual_legacy_marker_review';
    }
    else if (details.attachmentCount) action = 'manual_attachment_review';
    rows.push({ action, sourceService, targetService, sourceObjectKind, sourceObjectId, targetObjectUrl, ...details });
  }
}

function statusConflict(kind, githubNumber, githubState, gitlabIid, gitlabState, githubUrl, gitlabUrl) {
  if (gitlabState === 'opened') gitlabState = 'open';
  if (githubState === gitlabState) return null;
  return { action: 'status_conflict_review', objectKind: kind, githubNumber, githubState, githubUrl,
    gitlabIid, gitlabState, gitlabUrl, automaticMutation: false };
}

function githubThreadMetadata(comment) {
  return {
    reviewId: comment.pull_request_review_id ?? null,
    replyToId: comment.in_reply_to_id ?? null,
    filePath: comment.path ?? null,
    line: comment.line ?? comment.original_line ?? null,
    side: comment.side ?? comment.original_side ?? null,
  };
}

function gitlabThreadMetadata(discussion, note) {
  return {
    threadId: discussion.id ?? null,
    replyToId: note.in_reply_to_id ?? null,
    resolvable: note.resolvable ?? false,
    resolved: discussion.resolved ?? false,
  };
}

function makeCliApi({ githubCli = 'gh', gitlabCli = 'glab' } = {}) {
  const getJson = (bin, endpoint) => JSON.parse(execFileSync(bin, ['api', endpoint], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  return {
    github: (path) => getJson(githubCli, `repos/dinered/codexpro/${path.replace(/^\//, '')}`),
    gitlab: (path) => getJson(gitlabCli, `projects/27/${path.replace(/^\//, '')}`),
    pages(service, path) {
      const fetch = service === 'github' ? this.github : this.gitlab;
      const result = [];
      for (let page = 1; ; page += 1) {
        const query = `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`;
        const batch = fetch(query);
        if (!Array.isArray(batch)) throw new TypeError(`Expected ${service} collection response`);
        result.push(...batch);
        if (batch.length < 100) return result;
      }
    },
  };
}

function buildPlan(api, mapping) {
  const rows = [];
  for (const pair of mapping.issues) {
    const ghNumber = pair.githubNumber;
    const glIid = pair.gitlabIid;
    const ghIssue = api.github(`issues/${ghNumber}`);
    const glIssue = api.gitlab(`issues/${glIid}`);
    const status = statusConflict('issue', ghNumber, ghIssue.state, glIid, glIssue.state, ghIssue.html_url, glIssue.web_url);
    if (status) rows.push(status);
    const ghComments = api.pages('github', `issues/${ghNumber}/comments`);
    const glNotes = api.pages('gitlab', `issues/${glIid}/notes?activity_filter=only_comments`);
    addDirection(rows, { sourceService: 'github', sourceObjectKind: 'github-issue', sourceObjectId: ghNumber,
      sourceComments: ghComments, sourceObjectUrl: ghIssue.html_url, targetService: 'gitlab', targetComments: glNotes, targetObjectUrl: glIssue.web_url });
    addDirection(rows, { sourceService: 'gitlab', sourceObjectKind: 'gitlab-issue', sourceObjectId: glIid,
      sourceComments: glNotes, sourceObjectUrl: glIssue.web_url, targetService: 'github', targetComments: ghComments, targetObjectUrl: ghIssue.html_url });
  }

  for (const pair of mapping.pullRequests) {
    const ghNumber = pair.githubNumber;
    const glIid = pair.gitlabIid;
    const ghPr = api.github(`pulls/${ghNumber}`);
    const glMr = api.gitlab(`merge_requests/${glIid}`);
    const ghState = ghPr.merged_at ? 'merged' : ghPr.state;
    const glState = glMr.state === 'merged' ? 'merged' : glMr.state;
    const status = statusConflict('pull_request', ghNumber, ghState, glIid, glState, ghPr.html_url, glMr.web_url);
    if (status) rows.push(status);
    const ghComments = api.pages('github', `issues/${ghNumber}/comments`);
    const ghReviews = api.pages('github', `pulls/${ghNumber}/reviews`);
    const ghInline = api.pages('github', `pulls/${ghNumber}/comments`);
    const glNotes = api.pages('gitlab', `merge_requests/${glIid}/notes?activity_filter=only_comments`);
    const glDiscussions = api.pages('gitlab', `merge_requests/${glIid}/discussions`);
    const glInline = glDiscussions.flatMap((d) => d.notes ?? []).filter((n) => !n.system && n.position);
    addDirection(rows, { sourceService: 'github', sourceObjectKind: 'github-pr', sourceObjectId: ghNumber,
      sourceComments: ghComments, sourceObjectUrl: ghPr.html_url, targetService: 'gitlab', targetComments: glNotes, targetObjectUrl: glMr.web_url });
    addDirection(rows, { sourceService: 'gitlab', sourceObjectKind: 'gitlab-mr', sourceObjectId: glIid,
      sourceComments: glNotes, sourceObjectUrl: glMr.web_url, targetService: 'github', targetComments: ghComments, targetObjectUrl: ghPr.html_url });
    for (const review of ghReviews) {
      rows.push({ action: 'manual_review_history', sourceService: 'github', sourceObjectKind: 'github-pr', sourceObjectId: ghNumber,
        sourceReviewId: review.id, reviewState: review.state, author: review.user?.login ?? null,
        submittedAt: review.submitted_at ?? null, targetObjectUrl: glMr.web_url, automaticVote: false });
    }
    for (const comment of ghInline) rows.push({ action: 'manual_inline_thread_review', ...commentMetadata(comment, 'github', 'github-pr', ghNumber),
      ...githubThreadMetadata(comment), sourceObjectId: ghNumber, targetObjectUrl: glMr.web_url, automaticVote: false });
    for (const discussion of glDiscussions) {
      for (const note of discussion.notes ?? []) {
        if (note.system || !note.position) continue;
        rows.push({ action: 'manual_inline_thread_review', ...commentMetadata(note, 'gitlab', 'gitlab-mr', glIid, glMr.web_url),
          ...gitlabThreadMetadata(discussion, note), sourceObjectId: glIid, targetObjectUrl: ghPr.html_url, automaticVote: false });
      }
    }
  }

  const reverse = mapping.gitlabOnlyIssue;
  const glIssue = api.gitlab(`issues/${reverse.gitlabIid}`);
  const ghIssue = api.github(`issues/${reverse.githubNumber}`);
  const status = statusConflict('issue', reverse.githubNumber, ghIssue.state, reverse.gitlabIid, glIssue.state, ghIssue.html_url, glIssue.web_url);
  if (status) rows.push(status);
  const glNotes = api.pages('gitlab', `issues/${reverse.gitlabIid}/notes?activity_filter=only_comments`);
  const ghComments = api.pages('github', `issues/${reverse.githubNumber}/comments`);
  addDirection(rows, { sourceService: 'gitlab', sourceObjectKind: 'gitlab-issue', sourceObjectId: reverse.gitlabIid,
    sourceComments: glNotes, sourceObjectUrl: glIssue.web_url, targetService: 'github', targetComments: ghComments, targetObjectUrl: ghIssue.html_url });
  addDirection(rows, { sourceService: 'github', sourceObjectKind: 'github-issue', sourceObjectId: reverse.githubNumber,
    sourceComments: ghComments, sourceObjectUrl: ghIssue.html_url, targetService: 'gitlab', targetComments: glNotes, targetObjectUrl: glIssue.web_url });

  rows.sort((a, b) => [a.action, a.sourceService ?? '', a.sourceObjectKind ?? a.objectKind ?? '', String(a.sourceObjectId ?? a.githubNumber ?? ''), String(a.sourceCommentId ?? '')]
    .join('\0').localeCompare([b.action, b.sourceService ?? '', b.sourceObjectKind ?? b.objectKind ?? '', String(b.sourceObjectId ?? b.githubNumber ?? ''), String(b.sourceCommentId ?? '')].join('\0')));
  const summary = Object.fromEntries([...rows.reduce((counts, row) => counts.set(row.action, (counts.get(row.action) ?? 0) + 1), new Map())]);
  return { schemaVersion: 1, readOnly: true, githubRepository: mapping.githubRepository,
    gitlabProjectId: mapping.gitlabProjectId, summary, excluded: mapping.excluded ?? [], rows };
}

function main() {
  const args = process.argv.slice(2);
  const value = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const mappingPath = resolve(value('--mapping', resolve(here, 'mappings.json')));
  try {
    const mapping = JSON.parse(readFileSync(mappingPath, 'utf8'));
    const plan = buildPlan(makeCliApi({ githubCli: value('--github-cli', process.env.GH_CLI ?? 'gh'), gitlabCli: value('--gitlab-cli', process.env.GLAB_CLI ?? 'glab') }), mapping);
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } catch (error) {
    // Some CLI errors may contain response data; print only a type label.
    process.stderr.write(`discussion-sync plan failed (${error?.name ?? 'Error'}); no remote writes attempted\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export { addDirection, buildPlan, commentMetadata, gitlabThreadMetadata, githubThreadMetadata, markerPattern, parseMarkerIds, stableMarker, statusConflict };
