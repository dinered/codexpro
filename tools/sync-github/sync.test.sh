#!/bin/sh
# Functional tests use real bare repositories and independent concurrent writers.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo_root=$(cd "$here/../.." && pwd)
real_git=$(command -v git)
ci_rule=$(awk '/^sync-github:$/ {job=1} job && /^    - if:/ {print; exit}' "$repo_root/.gitlab-ci.yml")
for gate in 'FULL_REPO_SYNC_ENABLED == "true"' 'CI_COMMIT_REF_PROTECTED == "true"' \
  'CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH' 'CI_PIPELINE_SOURCE =~ /^(schedule|web)$/'; do
  printf '%s\n' "$ci_rule" | grep -Fq "$gate" || { echo "FAIL: sync-github CI rule missing gate: $gate"; exit 1; }
done
if printf '%s\n' "$ci_rule" | grep -Eq 'GITLAB_SYNC_TOKEN|GITHUB_SYNC_TOKEN'; then
  echo 'FAIL: sync-github CI rule still hides a missing-token diagnostic'; exit 1
fi
echo 'PASS: deploy rule keeps trusted gates while allowing the job to diagnose missing credentials'
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
n=0
new_case() {
  n=$((n+1)); d=$t/$n; mkdir "$d"
  for side in lab hub work; do git init -q --bare "$d/$side"; done
  tree=$(git --git-dir="$d/work" mktree < /dev/null)
  race=; race_path=$PATH; note_token=; note_issue=
  A=$(mk '' A)
}
g() { side=$1; shift; git --git-dir="$d/$side" "$@"; }
mk() { g work commit-tree "$tree" ${1:+-p "$1"} -m "$2"; }
put() { g work push -q "$d/$1" "$3:$2"; }
refs() { g "$1" for-each-ref --format='%(refname) %(objectname)' refs/heads refs/tags; }
run() {
  env CI= GITLAB_REPO_URL="file://$d/lab" GITHUB_REPO_URL="file://$d/hub" \
    GITLAB_SYNC_TOKEN="$note_token" GITHUB_SYNC_TOKEN= SYNC_NOTE_ISSUE="$note_issue" SYNC_APPLY="${apply:-1}" \
    CI_API_V4_URL= CI_PROJECT_ID= \
    TEST_DIR="$d" TEST_LAB="$d/lab" TEST_HUB="$d/hub" TEST_GIT="$real_git" \
    TEST_ACTION="$race" TEST_A="$A" TEST_B="${B:-}" TEST_C="${C:-}" \
    PATH="${race_path:-$PATH}" sh "$here/sync.sh" > "$d/log" 2>&1
}
ok() { if ! run; then cat "$d/log"; exit 1; fi; }
bad() { if run; then echo "FAIL: expected rejection in case $n"; cat "$d/log"; exit 1; fi; }
eq() { [ "$1" = "$2" ] || { echo "FAIL: $3 (case $n)"; exit 1; }; }
pass() { echo "PASS $n: $*"; }
install_race() {
  mkdir "$d/bin"
  cat > "$d/bin/git" <<'WRAPPER'
#!/bin/sh
case " $* " in
  *" ls-remote "*)
    n=0; [ ! -f "$TEST_DIR/count" ] || n=$(cat "$TEST_DIR/count")
    n=$((n+1)); echo "$n" > "$TEST_DIR/count"
    if [ "$TEST_ACTION" = source ] && [ "$n" = 3 ]; then
      "$TEST_GIT" --git-dir="$TEST_LAB" update-ref refs/heads/new "$TEST_A"
    fi
    if [ "$TEST_ACTION" = offline ] && [ -f "$TEST_DIR/injected" ]; then exit 1; fi;;
  *" push "*)
    if [ ! -f "$TEST_DIR/injected" ]; then
      touch "$TEST_DIR/injected"
      case "$TEST_ACTION" in
        advance) "$TEST_GIT" --git-dir="$TEST_HUB" update-ref refs/heads/main "$TEST_C";;
        delete) "$TEST_GIT" --git-dir="$TEST_HUB" update-ref -d refs/heads/main;;
        recreate) "$TEST_GIT" --git-dir="$TEST_HUB" update-ref refs/heads/missing "$TEST_C";;
        offline) exit 1;;
      esac
    fi;;
esac
exec "$TEST_GIT" "$@"
WRAPPER
  chmod 700 "$d/bin/git"
  race_path=$d/bin:$PATH
}
new_case
put lab refs/heads/main "$A"; put lab refs/heads/task/lab "$A"; put hub refs/heads/task/hub "$A"
put lab refs/tags/light "$A"
g work tag -a annotated "$A" -m release
tag=$(g work rev-parse refs/tags/annotated)
put hub refs/tags/annotated "$tag"; put lab refs/merge-requests/1/head "$A"
before_lab=$(refs lab); before_hub=$(refs hub)
apply=0; ok; apply=1
eq "$(refs lab)" "$before_lab" 'dry-run lab'; eq "$(refs hub)" "$before_hub" 'dry-run hub'
ok; eq "$(refs lab)" "$(refs hub)" 'all heads/tags'
eq "$(g hub for-each-ref refs/merge-requests)" '' 'internal refs excluded'
eq "$(g lab rev-parse refs/tags/annotated)" "$tag" 'annotated tag object'
ok; pass 'missing refs both directions; tags; internal refs; dry-run; idempotence'

new_case
B=$(mk "$A" B); C=$(mk "$B" C)
put lab refs/heads/main "$C"; put hub refs/heads/main "$A"
put lab refs/heads/topic "$B"; put hub refs/heads/topic "$C"
ok; eq "$(refs lab)" "$(refs hub)" 'FF both directions'
for side in lab hub; do g "$side" merge-base --is-ancestor "$A" "$C"; g "$side" fsck --no-dangling >/dev/null; done
pass 'fast-forward both directions preserves full ancestry'

for kind in branch tag; do
  new_case; B=$(mk "$A" B); C=$(mk "$A" C)
  if [ "$kind" = branch ]; then ref=refs/heads/main; else ref=refs/tags/release; fi
  put lab "$ref" "$B"; put hub "$ref" "$C"; put lab refs/heads/missing "$A"
  before_lab=$(refs lab); before_hub=$(refs hub)
  bad; eq "$(refs lab)" "$before_lab" 'conflict lab'; eq "$(refs hub)" "$before_hub" 'conflict hub'
  pass "$kind conflict aborts all writes"
done

new_case
g work tag -a release "$A" -m release
put lab refs/tags/release "$A"; put hub refs/tags/release "$(g work rev-parse refs/tags/release)"
bad; pass 'same peeled commit with different tag objects conflicts'

new_case
put lab refs/heads/main "$A"; race=source; install_race
bad; eq "$(refs hub)" '' 'new source prevents writes'; pass 'new source ref invalidates plan'

for mutation in advance delete recreate; do
  new_case; B=$(mk "$A" B); C=$(mk "$B" C)
  put lab refs/heads/main "$B"; put hub refs/heads/main "$A"; put lab refs/heads/missing "$B"
  put hub refs/keep/concurrent "$C"
  race=$mutation; install_race
  bad
  if [ "$mutation" = recreate ]; then eq "$(g hub rev-parse refs/heads/missing)" "$C" 'concurrent creation preserved'
  else eq "$(g hub for-each-ref refs/heads/missing)" '' 'atomic batch rejected'; fi
  eq "$(g lab rev-parse refs/heads/main)" "$B" 'source preserved'
  pass "concurrent target $mutation rejects atomic batch"
done

new_case
put lab refs/heads/lab "$A"; put hub refs/heads/hub "$A"
printf '#!/bin/sh\nexit 1\n' > "$d/hub/hooks/pre-receive"; chmod 700 "$d/hub/hooks/pre-receive"
bad
eq "$(g lab rev-parse refs/heads/hub)" "$A" 'first remote completed'
eq "$(g hub for-each-ref refs/heads/lab)" '' 'second remote rejected'
grep -q 'receipts после отказа push' "$d/log"
rm "$d/hub/hooks/pre-receive"
ok; eq "$(refs lab)" "$(refs hub)" 'rerun recovers'; pass 'cross-remote partial failure receipts and recovery'

new_case
# Deliberately constructed non-secret fixture; never include real credentials in tests.
blob=$(printf '%s %s\n' '-----BEGIN' 'PRIVATE KEY-----' | g work hash-object -w --stdin)
tree=$(printf '100644 blob %s\tfile\n' "$blob" | g work mktree)
B=$(mk "$A" fixture)
put lab refs/heads/main "$B"; put hub refs/heads/hub "$A"
before_lab=$(refs lab); before_hub=$(refs hub)
bad; grep -q 'потенциальный секрет' "$d/log"
eq "$(refs lab)" "$before_lab" 'secret lab'; eq "$(refs hub)" "$before_hub" 'secret hub'
if grep -q 'BEGIN PRIVATE' "$d/log"; then echo 'FAIL: scanner printed content'; exit 1; fi
pass 'secret pattern blocks both remotes without printing content'

new_case
ok; put lab refs/heads/main "$A"; put lab refs/tags/initial "$A"
ok; eq "$(refs lab)" "$(refs hub)" 'empty remote first publish'; pass 'empty repos and initial publication'

new_case
put lab refs/heads/main "$A"; race=offline; install_race
bad; grep -q 'refs недоступны' "$d/log"; eq "$(refs hub)" '' 'offline receipt'
pass 'receipt read failure is unavailable rather than empty'

new_case
if CI=true CI_COMMIT_BRANCH=task/topic CI_DEFAULT_BRANCH=main CI_COMMIT_REF_PROTECTED=false \
  GITLAB_REPO_URL="file://$d/lab" GITHUB_REPO_URL="file://$d/hub" \
  sh "$here/sync.sh" > "$d/log" 2>&1; then echo 'FAIL: unprotected CI accepted'; exit 1; fi
pass 'unprotected CI rejected before reading refs'

new_case
B=$(mk "$A" B); C=$(mk "$A" C)
put lab refs/heads/main "$B"; put hub refs/heads/main "$C"
note_token=nonsecret-fixture; note_issue=4
bad
grep -q 'Конфликты refs' "$d/log"
grep -q 'Заметка пропущена' "$d/log"
if grep -q 'parameter not set' "$d/log"; then echo 'FAIL: note masked the original error'; exit 1; fi
pass 'manual failure retains original error when Issue API metadata is unavailable'

new_case
mkdir "$d/bin"
cat > "$d/bin/git" <<'WRAPPER'
#!/bin/sh
case " $* " in *" ls-remote "*) touch "$TEST_DIR/network-attempt";; esac
exec "$TEST_GIT" "$@"
WRAPPER
chmod 700 "$d/bin/git"
if env CI=true CI_COMMIT_BRANCH=main CI_DEFAULT_BRANCH=main CI_COMMIT_REF_PROTECTED=true \
  GITLAB_SYNC_TOKEN=nonsecret-fixture-only GITHUB_SYNC_TOKEN= \
  GITLAB_REPO_URL="file://$d/lab" GITHUB_REPO_URL="file://$d/hub" \
  TEST_DIR="$d" TEST_GIT="$real_git" PATH="$d/bin:$PATH" \
  sh "$here/sync.sh" > "$d/log" 2>&1; then
  echo 'FAIL: missing CI token was accepted'; cat "$d/log"; exit 1
fi
grep -q 'отсутствуют обязательные CI-переменные: GITHUB_SYNC_TOKEN' "$d/log"
if grep -q 'nonsecret-fixture-only' "$d/log" || [ -e "$d/network-attempt" ]; then
  echo 'FAIL: missing-token diagnostic exposed a value or started network access'; cat "$d/log"; exit 1
fi
if env CI=true CI_COMMIT_BRANCH=main CI_DEFAULT_BRANCH=main CI_COMMIT_REF_PROTECTED=true \
  GITLAB_SYNC_TOKEN= GITHUB_SYNC_TOKEN=nonsecret-fixture-only \
  GITLAB_REPO_URL="file://$d/lab" GITHUB_REPO_URL="file://$d/hub" \
  TEST_DIR="$d" TEST_GIT="$real_git" PATH="$d/bin:$PATH" \
  sh "$here/sync.sh" > "$d/log" 2>&1; then
  echo 'FAIL: missing GitLab CI token was accepted'; cat "$d/log"; exit 1
fi
grep -q 'отсутствуют обязательные CI-переменные: GITLAB_SYNC_TOKEN' "$d/log"
if grep -q 'nonsecret-fixture-only' "$d/log" || [ -e "$d/network-attempt" ]; then
  echo 'FAIL: GitLab missing-token diagnostic exposed a value or started network access'; cat "$d/log"; exit 1
fi
pass 'missing CI credential names only the absent key and stops before network access'

new_case
put hub refs/heads/main "$A"
bad
grep -q 'GitLab main отсутствует' "$d/log"
eq "$(g lab for-each-ref refs/heads)" '' 'missing GitLab main remains absent'
pass 'GitHub main is never created by a direct push when the protected GitLab target is absent'

new_case
blob=$(printf '%s%s\n' '-----BEGIN ' 'PRIVATE KEY-----' | g work hash-object -w --stdin)
tree=$(printf '100644 blob %s\tfixture\n' "$blob" | g work mktree)
B=$(mk "$A" inbound-secret-fixture)
put lab refs/heads/main "$A"; put hub refs/heads/main "$B"
before_lab=$(refs lab); before_hub=$(refs hub)
bad
grep -q 'потенциальный секрет' "$d/log"
eq "$(refs lab)" "$before_lab" 'import secret lab refs'
eq "$(refs hub)" "$before_hub" 'import secret hub refs'
eq "$(g lab for-each-ref refs/heads/codexpro-sync/github-main-import)" '' 'secret import ref not published'
pass 'bounded scan blocks secret-pattern objects before protected-main MR import'

new_case
for reviewed_oid in 1c6ebfd0d136f4d4a3ee94b944dbe501602e3743 1af208bd6437ce625c9c4a9f0407ee90633303b6; do
  copied_oid=$(git -C "$repo_root" cat-file blob "$reviewed_oid" | g work hash-object -w --stdin)
  eq "$copied_oid" "$reviewed_oid" 'reviewed historical fixture blob is immutable'
done
tree=$(printf '100644 blob %s\ttools-sync-test-v1\n100644 blob %s\ttools-sync-test-v2\n' \
  1c6ebfd0d136f4d4a3ee94b944dbe501602e3743 1af208bd6437ce625c9c4a9f0407ee90633303b6 | g work mktree)
B=$(mk "$A" root-reviewed-historical-fixtures)
put lab refs/heads/main "$B"; put hub refs/heads/main "$A"
ok
eq "$(g lab rev-parse refs/heads/main)" "$B" 'reviewed historical test blobs pass narrowly'
eq "$(g hub rev-parse refs/heads/main)" "$B" 'outgoing reviewed fixture history remains synchronized'
pass 'only the two root-reviewed historical test blob OIDs are exempted from the scanner'

new_case
B=$(mk "$A" B); C=$(mk "$B" C); D=$(mk "$C" D); E=$(mk "$D" E)
put lab refs/heads/main "$A"; put lab refs/heads/lab-only "$A"
put hub refs/heads/main "$C"; put hub refs/heads/github-only "$A"
git --git-dir="$d/lab" config receive.advertisePushOptions true
mkdir "$d/bin"
cat > "$d/bin/git" <<'WRAPPER'
#!/bin/sh
case " $* " in *" push "*) printf 'git push %s\n' "$*" >> "$TEST_DIR/events";; esac
exec "$TEST_GIT" "$@"
WRAPPER
cat > "$d/bin/curl" <<'WRAPPER'
#!/bin/sh
cat > "$TEST_DIR/curl-config"
[ "${TEST_CURL_FAIL:-0}" != 1 ] || exit 1
[ "$(cat "$TEST_DIR/project-default-remove-source-branch")" = true ] || exit 3
output=$(sed -n 's/^output = "\(.*\)"$/\1/p' "$TEST_DIR/curl-config")
request=$(sed -n 's/^request = "\(.*\)"$/\1/p' "$TEST_DIR/curl-config")
case "$request" in
  POST)
    grep -q '^form-string = "remove_source_branch=false"$' "$TEST_DIR/curl-config" || exit 2
    printf 'api POST remove_source_branch=false\n' >> "$TEST_DIR/events"
    printf '%s\n' '[{"iid":1,"web_url":"http://gitlab.test/project/-/merge_requests/1","should_remove_source_branch":null,"force_remove_source_branch":false,"author":{"web_url":"http://gitlab.home.arpa/executor"}}]' > "$TEST_DIR/mr-state";;
  PUT)
    grep -q '^form-string = "remove_source_branch=false"$' "$TEST_DIR/curl-config" || exit 2
    printf 'api PUT remove_source_branch=false\n' >> "$TEST_DIR/events";;
  *) printf 'api GET\n' >> "$TEST_DIR/events";;
esac
if [ -f "$TEST_DIR/mr-state" ]; then cp "$TEST_DIR/mr-state" "$output"; else printf '[]' > "$output"; fi
WRAPPER
chmod 700 "$d/bin/git" "$d/bin/curl"
echo true > "$d/project-default-remove-source-branch"
run_mr() {
  env CI=true CI_COMMIT_BRANCH=main CI_DEFAULT_BRANCH=main CI_COMMIT_REF_PROTECTED=true \
    GITLAB_SYNC_TOKEN=nonsecret-gitlab-fixture GITHUB_SYNC_TOKEN=nonsecret-github-fixture \
    GITLAB_REPO_URL="file://$d/lab" GITHUB_REPO_URL="file://$d/hub" \
    SYNC_NOTE_ISSUE= SYNC_APPLY="${mr_apply:-1}" CI_API_V4_URL=http://gitlab.test/api/v4 CI_PROJECT_ID=1 CI_PROJECT_URL=http://gitlab.test/project \
    TEST_DIR="$d" TEST_GIT="$real_git" TEST_CURL_FAIL="${mr_curl_fail:-0}" PATH="$d/bin:$PATH" \
    sh "$here/sync.sh" > "$d/log" 2>&1
}
mr_ok() { if ! run_mr; then cat "$d/log"; exit 1; fi; }
mr_apply=0; mr_ok
grep -q '^gitlab-import refs/heads/codexpro-sync/github-main-import ' "$d/log"
eq "$(g lab rev-parse refs/heads/main)" "$A" 'dry-run protected main'
eq "$(g lab for-each-ref refs/heads/codexpro-sync/github-main-import)" '' 'dry-run import ref'
before_lab=$(refs lab); before_hub=$(refs hub)
mr_apply=1
mr_curl_fail=1
if run_mr; then echo 'FAIL: import MR preflight API error was accepted'; cat "$d/log"; exit 1; fi
grep -q 'Не удалось проверить открытый GitLab MR' "$d/log" || { echo 'FAIL: expected API preflight error'; cat "$d/log"; exit 1; }
eq "$(refs lab)" "$before_lab" 'MR API preflight lab refs'
eq "$(refs hub)" "$before_hub" 'MR API preflight hub refs'
mr_curl_fail=0
mr_apply=1
if ! run_mr; then cat "$d/log"; cat "$d/mr-state"; exit 1; fi
eq "$(g lab rev-parse refs/heads/main)" "$A" 'import does not write protected main'
eq "$(g lab rev-parse refs/heads/codexpro-sync/github-main-import)" "$C" 'import branch source SHA'
grep -q '^api POST remove_source_branch=false$' "$d/events"
grep -q '^api PUT remove_source_branch=false$' "$d/events"
if grep -q 'merge_request.create' "$d/events"; then echo 'FAIL: push option created the import MR'; exit 1; fi
grep -q 'url=http://gitlab.test/project/-/merge_requests/1$' "$d/log" || { echo 'FAIL: nested author web_url replaced the MR URL'; cat "$d/log"; exit 1; }
push_line=$(grep -n '^git push .*codexpro-sync/github-main-import' "$d/events" | head -n 1 | cut -d: -f1)
post_line=$(grep -n '^api POST ' "$d/events" | head -n 1 | cut -d: -f1)
[ "$push_line" -lt "$post_line" ] || { echo 'FAIL: import MR API create preceded import branch push'; exit 1; }
pre_mr_pushes=$(awk '/^api POST / {exit} /^git push / {n++} END {print n+0}' "$d/events")
[ "$pre_mr_pushes" = 1 ] || { echo 'FAIL: unrelated refs were pushed before MR creation'; cat "$d/events"; exit 1; }
grep -q 'ожидает обычного merge request merge' "$d/log"
eq "$(g lab rev-parse refs/heads/lab-only)" "$A" 'other GitLab head preserved'
eq "$(g hub rev-parse refs/heads/github-only)" "$A" 'other GitHub head preserved'
mr_ok
put_count=$(grep -c '^api PUT remove_source_branch=false$' "$d/events")
[ "$put_count" -ge 2 ] || { echo 'FAIL: existing MR with default removal=true/null was accepted without explicit PUT'; exit 1; }
grep -q 'url=http://gitlab.test/project/-/merge_requests/1$' "$d/log" || { echo 'FAIL: existing MR URL was not derived from project URL and IID'; exit 1; }
pass 'GitHub main import uses stable reviewed branch and keeps protected main unchanged'

put hub refs/heads/main "$D"
mr_ok
eq "$(g lab rev-parse refs/heads/codexpro-sync/github-main-import)" "$D" 'open MR branch fast-forward'
grep -q 'ожидает обычного merge request merge' "$d/log"
pass 'open import MR is reused on later fast-forward without another create option'

g lab update-ref refs/heads/main "$D"
put hub refs/heads/main "$E"
rm -f "$d/mr-state"
mr_ok
eq "$(g lab rev-parse refs/heads/main)" "$D" 'protected main unchanged before MR merge'
eq "$(g lab rev-parse refs/heads/codexpro-sync/github-main-import)" "$E" 'existing branch updated before fallback MR creation'
grep -Fq '"should_remove_source_branch":null' "$d/mr-state"
grep -Fq '"author":{"web_url":"http://gitlab.home.arpa/executor"}' "$d/mr-state"
grep -q '^api POST remove_source_branch=false$' "$d/events"
pass 'existing import branch without an open MR recreates the reviewed MR after FF'

g lab update-ref refs/heads/main "$E"
mr_ok
lab_public=$(refs lab | awk '$1 != "refs/heads/codexpro-sync/github-main-import"')
eq "$lab_public" "$(refs hub)" 'post-merge public heads/tags equality'
eq "$(g lab rev-parse refs/heads/codexpro-sync/github-main-import)" "$E" 'reserved branch retained outside public inventory'
pass 'after normal main merge, ordinary sync confirms user refs equal and keeps reserved branch'
echo "sync.sh: $n functional scenarios passed"
