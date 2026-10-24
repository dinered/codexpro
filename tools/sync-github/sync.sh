#!/bin/sh
# Все пользовательские heads/tags; только создание и fast-forward. По умолчанию dry-run.
# SYNC_APPLY=1 разрешает публикацию; CI допускается только с защищённого main.
set +x
set -eu
unset GIT_TRACE GIT_TRACE_PACKET GIT_TRACE_CURL GIT_CURL_VERBOSE
export GIT_TERMINAL_PROMPT=0
: "${GITLAB_REPO_URL:?нужен адрес GitLab}" "${GITHUB_REPO_URL:?нужен адрес GitHub}"
for url in "$GITLAB_REPO_URL" "$GITHUB_REPO_URL"; do
  case "$url" in http*://*@*|http*://*\?*|http*://*\#*) echo 'Нужен URL без credentials/query/fragment' >&2; exit 1;; esac
done
case ${SYNC_APPLY:-0} in 0|1) ;; *) echo 'SYNC_APPLY должен быть 0 или 1' >&2; exit 1;; esac
if [ -n "${CI:-}" ]; then
  [ "${CI_COMMIT_BRANCH:-}" = "${CI_DEFAULT_BRANCH:-main}" ] &&
    [ "${CI_COMMIT_REF_PROTECTED:-}" = true ] || { echo 'Нужен защищённый default branch' >&2; exit 1; }
fi
umask 077
repo=$(mktemp -d)
trap 'rm -rf "$repo"' EXIT
trap 'exit 1' HUP INT TERM
git init -q --bare "$repo/git"
g() { git --git-dir="$repo/git" "$@"; }
origin() { printf '%s\n' "$1" | sed -E 's#^([a-z]+://[^/]+).*#\1#'; }
g config credential.helper ""
if [ -n "${GITLAB_SYNC_TOKEN:-}" ]; then
  g config "credential.$(origin "$GITLAB_REPO_URL").helper" \
    '!f() { [ "$1" = get ] && printf "username=sync\npassword=%s\n" "$GITLAB_SYNC_TOKEN"; }; f'
fi
if [ -n "${GITHUB_SYNC_TOKEN:-}" ]; then
  g config "credential.$(origin "$GITHUB_REPO_URL").helper" \
    '!f() { [ "$1" = get ] && printf "username=x-access-token\npassword=%s\n" "$GITHUB_SYNC_TOKEN"; }; f'
fi
g remote add gitlab "$GITLAB_REPO_URL"
g remote add github "$GITHUB_REPO_URL"
note() {
  [ -n "${SYNC_NOTE_ISSUE:-}" ] && [ -n "${GITLAB_SYNC_TOKEN:-}" ] || return 0
  if [ -z "${CI_API_V4_URL:-}" ] || [ -z "${CI_PROJECT_ID:-}" ]; then
    echo 'Заметка пропущена: отсутствует API URL/project ID; исходная ошибка сохранена' >&2
    return 0
  fi
  printf 'url = "%s/projects/%s/issues/%s/notes"\nheader = "PRIVATE-TOKEN: %s"\nform-string = "body=%s"\nfail\nsilent\nshow-error\noutput = "/dev/null"\n' \
    "$CI_API_V4_URL" "$CI_PROJECT_ID" "$SYNC_NOTE_ISSUE" "$GITLAB_SYNC_TOKEN" "$1${CI_PIPELINE_URL:+ Пайплайн: $CI_PIPELINE_URL}" | curl -K -
}
fail() {
  echo "sync-github: $*" >&2
  note "sync-github: $*" || echo 'Не удалось записать заметку в Issue' >&2
  exit 1
}
# Только refs/heads и refs/tags. --refs исключает peeled tags и служебные refs.
snapshot() {
  g ls-remote --refs --heads --tags "$1" > "$repo/remote" || return 1
  LC_ALL=C sort -k2 "$repo/remote" > "$2"
}
for side in gitlab github; do
  snapshot "$side" "$repo/$side.before"
  g fetch -q --no-tags "$side" "refs/heads/*:refs/sync/$side/heads/*" "refs/tags/*:refs/sync/$side/tags/*"
  g for-each-ref --format='%(objectname) %(refname)' "refs/sync/$side/" |
    awk -v s="$side" '{sub("refs/sync/" s "/", "refs/", $2); printf "%s\t%s\n", $1, $2}' | LC_ALL=C sort -k2 > "$repo/$side.fetched"
  cmp -s "$repo/$side.before" "$repo/$side.fetched" || fail "refs $side изменились во время fetch; повторите запуск"
done
# Полная проверка конфликтов до первого push: при любом конфликте план не выполняется.
awk 'FILENAME == ARGV[1] {lab[$2]=$1; refs[$2]=1; next} {hub[$2]=$1; refs[$2]=1} END {for(r in refs) print r, (lab[r] ? lab[r] : "-"), (hub[r] ? hub[r] : "-")}' \
  "$repo/gitlab.before" "$repo/github.before" | LC_ALL=C sort > "$repo/union"
: > "$repo/plan"
conflict=0
while read -r ref lab hub; do
  [ "$lab" != "$hub" ] || continue
  if [ "$lab" = - ]; then
    echo "gitlab $ref $hub -" >> "$repo/plan"
  elif [ "$hub" = - ]; then
    echo "github $ref $lab -" >> "$repo/plan"
  elif [ "${ref#refs/tags/}" != "$ref" ]; then
    echo "Конфликт тега $ref: GitLab=$lab GitHub=$hub" >&2
    conflict=1
  elif g merge-base --is-ancestor "$lab" "$hub"; then
    echo "gitlab $ref $hub $lab" >> "$repo/plan"
  elif g merge-base --is-ancestor "$hub" "$lab"; then
    echo "github $ref $lab $hub" >> "$repo/plan"
  else
    echo "Ветки разошлись $ref: GitLab=$lab GitHub=$hub" >&2
    conflict=1
  fi
done < "$repo/union"
[ "$conflict" = 0 ] || fail 'Конфликты refs; ни один push не выполнен. См. docs/github-sync.md'
cat "$repo/plan"
if [ "${SYNC_APPLY:-0}" != 1 ]; then
  echo 'sync-github: dry-run; публикации нет (для выполнения SYNC_APPLY=1)'
  exit 0
fi
# Ограниченная pattern-проверка всех новых объектов перед ЛЮБОЙ публикацией.
# Значения и содержимое объектов в журнал не выводятся; это не доказательство отсутствия всех секретов.
for side in gitlab github; do
  awk -v s="$side" '$1==s {print $3}' "$repo/plan" > "$repo/scan-revs"
  [ -s "$repo/scan-revs" ] || continue
  cut -f1 "$repo/$side.before" | sed 's/^/^/' >> "$repo/scan-revs"
  g rev-list --objects --stdin < "$repo/scan-revs" > "$repo/objects"
  cut -d' ' -f1 "$repo/objects" | LC_ALL=C sort -u > "$repo/oids"
  while read -r oid; do
    kind=$(g cat-file -t "$oid")
    [ "$kind" != tree ] || continue
    g cat-file "$kind" "$oid" > "$repo/object"
    if LC_ALL=C grep -aEq -- '-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|glpat-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,}' "$repo/object"; then
      fail "Pattern-проверка: потенциальный секрет в объекте $oid; публикация остановлена, требуется приватная проверка"
    fi
  done < "$repo/oids"
done
# Повторно проверяем обе стороны: новые refs/смена источника/удаление требуют нового плана.
for side in gitlab github; do
  snapshot "$side" "$repo/$side.recheck"
  cmp -s "$repo/$side.before" "$repo/$side.recheck" || fail "refs $side изменились перед публикацией; повторите запуск"
done
push_failed() {
  echo "sync-github: receipts после отказа push (возможен частичный результат)" >&2
  for remote in gitlab github; do
    echo "$remote:" >&2
    if snapshot "$remote" "$repo/$remote.receipt"; then cat "$repo/$remote.receipt" >&2; else echo "refs недоступны" >&2; fi
  done
  fail "$*"
}
for side in gitlab github; do
  set --
  while read -r dest ref src old; do
    [ "$dest" = "$side" ] || continue
    if [ "$old" = - ]; then old=; else
      # Lease — только CAS: даже при программной ошибке здесь нельзя разрешить non-FF.
      [ "${ref#refs/heads/}" != "$ref" ] && g merge-base --is-ancestor "$old" "$src" || fail "Недопустимая перезапись $ref"
    fi
    set -- "$@" "--force-with-lease=$ref:$old" "$src:$ref"
  done < "$repo/plan"
  [ "$#" -gt 0 ] || continue
  # Atomic внутри одной стороны; общей транзакции двух серверов Git не предоставляет.
  # ci.skip исключает рекурсивные branch pipelines; sync запускается только schedule/web.
  if [ "$side" = gitlab ] && [ -n "${CI:-}" ]; then
    g push --atomic -o ci.skip "$side" "$@" || push_failed 'Push GitLab отклонён; проверьте refs обеих сторон перед повтором'
  else
    g push --atomic "$side" "$@" || push_failed "Push $side отклонён; проверьте refs обеих сторон перед повтором"
  fi
done
snapshot gitlab "$repo/gitlab.after"
snapshot github "$repo/github.after"
cmp -s "$repo/gitlab.after" "$repo/github.after" || fail 'Итоговые refs отличаются; возможна конкурентная запись, нужен новый запуск'
echo 'sync-github: подтверждено равенство всех heads/tags'
cat "$repo/gitlab.after"
