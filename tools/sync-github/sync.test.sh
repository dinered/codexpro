#!/bin/sh
# Functional tests use real bare repositories and independent concurrent writers.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
real_git=$(command -v git)
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
n=0
new_case() {
  n=$((n+1)); d=$t/$n; mkdir "$d"
  for side in lab hub work; do git init -q --bare "$d/$side"; done
  tree=$(git --git-dir="$d/work" mktree < /dev/null)
  race=; race_path=$PATH
  A=$(mk '' A)
}
g() { side=$1; shift; git --git-dir="$d/$side" "$@"; }
mk() { g work commit-tree "$tree" ${1:+-p "$1"} -m "$2"; }
put() { g work push -q "$d/$1" "$3:$2"; }
refs() { g "$1" for-each-ref --format='%(refname) %(objectname)' refs/heads refs/tags; }
run() {
  env CI= GITLAB_REPO_URL="file://$d/lab" GITHUB_REPO_URL="file://$d/hub" \
    GITLAB_SYNC_TOKEN= GITHUB_SYNC_TOKEN= SYNC_NOTE_ISSUE= SYNC_APPLY="${apply:-1}" \
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
echo "sync.sh: $n functional scenarios passed"
