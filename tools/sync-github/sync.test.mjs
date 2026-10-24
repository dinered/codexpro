import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve(import.meta.dirname, 'sync.sh');
const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const identity = { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sync-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = Object.fromEntries(['lab', 'hub', 'work'].map(n => [n, join(dir, n)]));
  const git = (side, ...args) => {
    const r = spawnSync(realGit, ['--git-dir', paths[side], ...args], { encoding: 'utf8', env: { ...process.env, ...identity } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  for (const path of Object.values(paths)) assert.equal(spawnSync(realGit, ['init', '-q', '--bare', path]).status, 0);
  const tree = git('work', 'mktree');
  const commit = (parent, message = 'test', content) => {
    let currentTree = tree;
    if (content) {
      const blob = spawnSync(realGit, ['--git-dir', paths.work, 'hash-object', '-w', '--stdin'], { input: content, encoding: 'utf8' }).stdout.trim();
      currentTree = spawnSync(realGit, ['--git-dir', paths.work, 'mktree'], { input: `100644 blob ${blob}\tfile\n`, encoding: 'utf8' }).stdout.trim();
    }
    return git('work', 'commit-tree', currentTree, ...(parent ? ['-p', parent] : []), '-m', message);
  };
  const put = (side, ref, oid) => git('work', 'push', '-q', paths[side], `${oid}:${ref}`);
  const refs = side => git(side, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags');
  const run = (extra = {}) => spawnSync('sh', [script], { encoding: 'utf8', env: {
    ...process.env, CI: '', GITLAB_REPO_URL: `file://${paths.lab}`, GITHUB_REPO_URL: `file://${paths.hub}`,
    GITLAB_SYNC_TOKEN: '', GITHUB_SYNC_TOKEN: '', SYNC_NOTE_ISSUE: '', SYNC_APPLY: '1', ...extra,
  } });
  // Независимый конкурент через git wrapper. Рабочий скрипт не содержит тестовых hooks.
  const race = body => {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin/git'), `#!/bin/sh\n${body}\nexec '${realGit}' "$@"\n`, { mode: 0o700 });
    return { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, TEST_DIR: dir, TEST_LAB: paths.lab, TEST_HUB: paths.hub, TEST_GIT: realGit };
  };
  const A = commit(null, 'A');
  return { dir, paths, git, commit, put, refs, run, race, A };
}
const success = r => assert.equal(r.status, 0, r.stderr + r.stdout);
const failure = r => assert.notEqual(r.status, 0, 'operation unexpectedly succeeded');

test('all user branches and annotated/lightweight tags, either side missing; internal refs excluded; default dry-run', t => {
  const f = fixture(t); const { A } = f;
  f.put('lab', 'refs/heads/main', A);
  f.put('lab', 'refs/heads/task/lab', A);
  f.put('hub', 'refs/heads/task/hub', A);
  f.put('lab', 'refs/tags/light', A);
  f.git('work', 'tag', '-a', 'annotated', A, '-m', 'release');
  const tag = f.git('work', 'rev-parse', 'refs/tags/annotated');
  f.put('hub', 'refs/tags/annotated', tag);
  f.put('lab', 'refs/merge-requests/1/head', A);
  const before = [f.refs('lab'), f.refs('hub')];
  success(f.run({ SYNC_APPLY: '0' }));
  assert.deepEqual([f.refs('lab'), f.refs('hub')], before);
  success(f.run());
  assert.equal(f.refs('lab'), f.refs('hub'));
  assert.equal(f.git('hub', 'for-each-ref', 'refs/merge-requests'), '');
  assert.equal(f.git('lab', 'rev-parse', 'refs/tags/annotated'), tag);
  success(f.run());
});

test('fast-forward in both directions across different branches preserves full ancestry', t => {
  const f = fixture(t), B = f.commit(f.A, 'B'), C = f.commit(B, 'C');
  f.put('lab', 'refs/heads/main', C); f.put('hub', 'refs/heads/main', f.A);
  f.put('lab', 'refs/heads/topic', B); f.put('hub', 'refs/heads/topic', C);
  success(f.run());
  assert.equal(f.refs('lab'), f.refs('hub'));
  for (const side of ['lab', 'hub']) {
    assert.equal(f.git(side, 'rev-parse', 'refs/heads/main'), C);
    f.git(side, 'merge-base', '--is-ancestor', f.A, C);
    f.git(side, 'fsck', '--no-dangling');
  }
});

for (const kind of ['branch', 'tag']) test(`${kind} conflict aborts the entire plan before any writes`, t => {
  const f = fixture(t), B = f.commit(f.A, 'B'), C = f.commit(f.A, 'C');
  const ref = kind === 'branch' ? 'refs/heads/main' : 'refs/tags/release';
  f.put('lab', ref, B); f.put('hub', ref, C);
  f.put('lab', 'refs/heads/missing', f.A);
  const before = [f.refs('lab'), f.refs('hub')];
  failure(f.run());
  assert.deepEqual([f.refs('lab'), f.refs('hub')], before);
});

test('tags pointing to same commit but different tag objects conflict', t => {
  const f = fixture(t);
  f.git('work', 'tag', '-a', 'release', f.A, '-m', 'release');
  f.put('lab', 'refs/tags/release', f.A);
  f.put('hub', 'refs/tags/release', f.git('work', 'rev-parse', 'refs/tags/release'));
  failure(f.run());
});

test('new source branch appearing after fetch invalidates the plan', t => {
  const f = fixture(t); f.put('lab', 'refs/heads/main', f.A);
  const env = f.race(`case " $* " in *" ls-remote "*)
    n=0; [ ! -f "$TEST_DIR/count" ] || n=$(cat "$TEST_DIR/count")
    n=$((n+1)); echo "$n" > "$TEST_DIR/count"
    if [ "$n" = 3 ]; then "$TEST_GIT" --git-dir="$TEST_LAB" update-ref refs/heads/new '${f.A}'; fi;; esac`);
  failure(f.run(env)); assert.equal(f.refs('hub'), '');
});

for (const mutation of ['advance', 'delete', 'recreate']) test(`target ${mutation} between recheck and push rejects atomic batch`, t => {
  const f = fixture(t), B = f.commit(f.A, 'B'), C = f.commit(B, 'C');
  f.put('lab', 'refs/heads/main', B); f.put('hub', 'refs/heads/main', f.A);
  f.put('lab', 'refs/heads/missing', B);
  // Preload an otherwise unreachable object for the independent writer.
  f.put('hub', 'refs/keep/concurrent', C);
  const change = mutation === 'advance' ? `update-ref refs/heads/main '${C}'` : mutation === 'delete' ? 'update-ref -d refs/heads/main' : `update-ref refs/heads/missing '${C}'`;
  const env = f.race(`case " $* " in *" push "*)
    if [ ! -f "$TEST_DIR/injected" ]; then
      touch "$TEST_DIR/injected"
      "$TEST_GIT" --git-dir="$TEST_HUB" ${change}
    fi;; esac`);
  const r = f.run(env); failure(r);
  if (mutation === 'recreate') assert.equal(f.git('hub', 'rev-parse', 'refs/heads/missing'), C);
  else assert.equal(f.git('hub', 'for-each-ref', 'refs/heads/missing'), '');
  assert.equal(f.git('lab', 'rev-parse', 'refs/heads/main'), B);
});

test('partial cross-remote failure preserves completed FF and recovers on rerun', t => {
  const f = fixture(t), B = f.commit(f.A, 'B');
  f.put('lab', 'refs/heads/lab', B); f.put('hub', 'refs/heads/hub', f.A);
  const hook = join(f.paths.hub, 'hooks/pre-receive');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const r = f.run(); failure(r);
  assert.equal(f.git('lab', 'rev-parse', 'refs/heads/hub'), f.A);
  assert.equal(f.git('hub', 'for-each-ref', 'refs/heads/lab'), '');
  assert.match(r.stderr, /Push github отклонён/);
  assert.match(r.stderr, /receipts после отказа push/);
  assert.match(r.stderr, new RegExp(f.A));
  rmSync(hook);
  success(f.run()); assert.equal(f.refs('lab'), f.refs('hub'));
});

test('potential secrets in outgoing history stop both destinations before push', t => {
  const f = fixture(t), bad = f.commit(f.A, 'example secret fixture', ['-----BEGIN', 'PRIVATE KEY-----'].join(' '));
  f.put('lab', 'refs/heads/main', bad); f.put('hub', 'refs/heads/hub', f.A);
  const before = [f.refs('lab'), f.refs('hub')];
  const r = f.run(); failure(r);
  assert.match(r.stderr, /потенциальный секрет/);
  assert.deepEqual([f.refs('lab'), f.refs('hub')], before);
  assert.doesNotMatch(r.stderr, /BEGIN PRIVATE/);
});

test('empty repositories and first complete publication to empty remote', t => {
  const f = fixture(t); success(f.run());
  f.put('lab', 'refs/heads/main', f.A);
  f.put('lab', 'refs/tags/initial', f.A);
  success(f.run()); assert.equal(f.refs('lab'), f.refs('hub'));
});

test('read failure during post-push receipt is reported unavailable, never as an empty remote', t => {
  const f = fixture(t); f.put('lab', 'refs/heads/main', f.A);
  const env = f.race(`case " $* " in
    *" push "*) touch "$TEST_DIR/offline"; exit 1;;
    *" ls-remote "*) if [ -f "$TEST_DIR/offline" ]; then exit 1; fi;;
  esac`);
  const r = f.run(env); failure(r);
  assert.match(r.stderr, /refs недоступны/);
  assert.equal(f.refs('hub'), '');
});

test('CI invocation outside protected default branch fails before reading refs', t => {
  const f = fixture(t);
  failure(f.run({ CI: 'true', CI_COMMIT_BRANCH: 'task/topic', CI_DEFAULT_BRANCH: 'main', CI_COMMIT_REF_PROTECTED: 'false' }));
});
