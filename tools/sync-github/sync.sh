#!/bin/sh
# Все пользовательские heads/tags; только создание и fast-forward. По умолчанию dry-run.
# SYNC_APPLY=1 разрешает публикацию; CI допускается только с защищённого main.
set +x
set -eu
unset GIT_TRACE GIT_TRACE_PACKET GIT_TRACE_CURL GIT_CURL_VERBOSE
export GIT_TERMINAL_PROMPT=0
import_ref=refs/heads/codexpro-sync/github-main-import
if [ -n "${CI:-}" ]; then
  [ "${CI_COMMIT_BRANCH:-}" = "${CI_DEFAULT_BRANCH:-main}" ] &&
    [ "${CI_COMMIT_REF_PROTECTED:-}" = true ] || { echo 'Нужен защищённый default branch' >&2; exit 1; }
  missing=
  [ -n "${GITLAB_SYNC_TOKEN:-}" ] || missing='GITLAB_SYNC_TOKEN'
  [ -n "${GITHUB_SYNC_TOKEN:-}" ] || missing="${missing}${missing:+ }GITHUB_SYNC_TOKEN"
  if [ -n "$missing" ]; then
    echo "sync-github: отсутствуют обязательные CI-переменные: $missing" >&2
    exit 1
  fi
fi
: "${GITLAB_REPO_URL:?нужен адрес GitLab}" "${GITHUB_REPO_URL:?нужен адрес GitHub}"
for url in "$GITLAB_REPO_URL" "$GITHUB_REPO_URL"; do
  case "$url" in http*://*@*|http*://*\?*|http*://*\#*) echo 'Нужен URL без credentials/query/fragment' >&2; exit 1;; esac
done
case ${SYNC_APPLY:-0} in 0|1) ;; *) echo 'SYNC_APPLY должен быть 0 или 1' >&2; exit 1;; esac
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
  snapshot "$side" "$repo/$side.all.before"
  if [ "$side" = gitlab ]; then
    awk -v internal="$import_ref" '$2 != internal' "$repo/$side.all.before" > "$repo/$side.before"
  else
    cp "$repo/$side.all.before" "$repo/$side.before"
  fi
  g fetch -q --no-tags "$side" "refs/heads/*:refs/sync/$side/heads/*" "refs/tags/*:refs/sync/$side/tags/*"
  g for-each-ref --format='%(objectname) %(refname)' "refs/sync/$side/" |
    awk -v s="$side" -v internal="$import_ref" '{sub("refs/sync/" s "/", "refs/", $2); if (!(s == "gitlab" && $2 == internal)) printf "%s\t%s\n", $1, $2}' | LC_ALL=C sort -k2 > "$repo/$side.fetched"
  cmp -s "$repo/$side.before" "$repo/$side.fetched" || fail "refs $side изменились во время fetch; повторите запуск"
done
if awk -v internal="$import_ref" '$2 == internal {found=1} END {exit !found}' "$repo/github.all.before"; then
  fail "зарезервированная import-ветка существует на GitHub: $import_ref"
fi
import_old=$(awk -v internal="$import_ref" '$2 == internal {print $1}' "$repo/gitlab.all.before")
import_old=${import_old:--}
# Полная проверка конфликтов до первого push: при любом конфликте план не выполняется.
awk 'FILENAME == ARGV[1] {lab[$2]=$1; refs[$2]=1; next} {hub[$2]=$1; refs[$2]=1} END {for(r in refs) print r, (lab[r] ? lab[r] : "-"), (hub[r] ? hub[r] : "-")}' \
  "$repo/gitlab.before" "$repo/github.before" | LC_ALL=C sort > "$repo/union"
: > "$repo/plan"
conflict=0
while read -r ref lab hub; do
  [ "$lab" != "$hub" ] || continue
  if [ "$lab" = - ]; then
    if [ "$ref" = refs/heads/main ]; then
      echo 'GitLab main отсутствует; создание защищённой target-ветки запрещено, требуется ручное восстановление' >&2
      conflict=1
    else
      echo "gitlab $ref $hub -" >> "$repo/plan"
    fi
  elif [ "$hub" = - ]; then
    echo "github $ref $lab -" >> "$repo/plan"
  elif [ "${ref#refs/tags/}" != "$ref" ]; then
    echo "Конфликт тега $ref: GitLab=$lab GitHub=$hub" >&2
    conflict=1
  elif g merge-base --is-ancestor "$lab" "$hub"; then
    if [ "$ref" = refs/heads/main ]; then
      if [ "$import_old" != - ] && ! g merge-base --is-ancestor "$import_old" "$hub"; then
        echo "GitLab import-ветка разошлась: $import_ref=$import_old, GitHub main=$hub" >&2
        conflict=1
      else
        echo "gitlab-import $import_ref $hub $import_old" >> "$repo/plan"
      fi
    else
      echo "gitlab $ref $hub $lab" >> "$repo/plan"
    fi
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
  awk -v s="$side" '$1==s || (s == "gitlab" && $1 == "gitlab-import") {print $3}' "$repo/plan" > "$repo/scan-revs"
  [ -s "$repo/scan-revs" ] || continue
  cut -f1 "$repo/$side.all.before" | sed 's/^/^/' >> "$repo/scan-revs"
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
  snapshot "$side" "$repo/$side.all.recheck"
  cmp -s "$repo/$side.all.before" "$repo/$side.all.recheck" || fail "refs $side изменились перед публикацией; повторите запуск"
done
push_failed() {
  echo "sync-github: receipts после отказа push (возможен частичный результат)" >&2
  for remote in gitlab github; do
    echo "$remote:" >&2
    if snapshot "$remote" "$repo/$remote.receipt"; then cat "$repo/$remote.receipt" >&2; else echo "refs недоступны" >&2; fi
  done
  fail "$*"
}
if grep -q '^gitlab-import ' "$repo/plan"; then
  import_src=$(awk '$1 == "gitlab-import" {print $3}' "$repo/plan")
  import_expected=$(awk '$1 == "gitlab-import" {print $4}' "$repo/plan")
  mr_api_url="${CI_API_V4_URL:?нужен CI_API_V4_URL}/projects/${CI_PROJECT_ID:?нужен CI_PROJECT_ID}/merge_requests"
  mr_query="$mr_api_url?state=opened&source_branch=codexpro-sync%2Fgithub-main-import&target_branch=main&per_page=100"
  read_open_mr() {
    printf 'url = "%s"\nheader = "PRIVATE-TOKEN: %s"\nfail\nsilent\nshow-error\noutput = "%s"\n' \
      "$mr_query" "$GITLAB_SYNC_TOKEN" "$repo/open-mr.json" | curl -K - || return 1
    tr -d '\n' < "$repo/open-mr.json" | sed 's/"iid":[[:space:]]*/"iid":/g; s/"should_remove_source_branch":[[:space:]]*/"should_remove_source_branch":/g; s/"force_remove_source_branch":[[:space:]]*/"force_remove_source_branch":/g' > "$repo/open-mr.compact" || return 1
    open_mr_count=$(awk '{n+=gsub(/"iid"[[:space:]]*:/, "&")} END {print n+0}' "$repo/open-mr.compact")
    open_mr_url=$(sed -n 's/.*"web_url":"\([^"]*\)".*/\1/p' "$repo/open-mr.compact")
    open_mr_iid=$(sed -n 's/.*"iid":\([0-9][0-9]*\).*/\1/p' "$repo/open-mr.compact")
    open_mr_remove_source=$(sed -n 's/.*"should_remove_source_branch":\([^,}]*\).*/\1/p' "$repo/open-mr.compact")
    open_mr_force_remove=$(sed -n 's/.*"force_remove_source_branch":\([^,}]*\).*/\1/p' "$repo/open-mr.compact")
  }
  set_source_branch_retention() {
    [ -n "$open_mr_iid" ] || return 1
    [ "$open_mr_force_remove" = false ] || return 1
    # This GitLab returns null for the false/unset API field; the existing glab
    # view normalizes that state to false. Only an explicit true is unsafe.
    case "$open_mr_remove_source" in false|null) return 0;; esac
    printf 'url = "%s/%s"\nheader = "PRIVATE-TOKEN: %s"\nrequest = "PUT"\nform-string = "remove_source_branch=false"\nfail\nsilent\nshow-error\noutput = "%s"\n' \
      "$mr_api_url" "$open_mr_iid" "$GITLAB_SYNC_TOKEN" "$repo/update-mr.json" | curl -K - || return 1
    read_open_mr || return 1
    [ "$open_mr_count" = 1 ] && [ "$open_mr_force_remove" = false ] || return 1
    case "$open_mr_remove_source" in false|null) return 0;; esac
    return 1
  }
  read_open_mr || fail 'Не удалось проверить открытый GitLab MR для main import; refs не опубликованы'
  [ "$open_mr_count" -le 1 ] || fail 'Для main import найдено несколько открытых MR; refs не опубликованы'
  if [ "$open_mr_count" = 1 ]; then
    set_source_branch_retention || fail 'Открытый import MR принудительно удаляет source branch либо его настройку нельзя подтвердить'
  fi
fi
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
if grep -q '^gitlab-import ' "$repo/plan"; then
  # Keep MR creation separate from the ordinary atomic ref batch: push options
  # apply to the whole push and must not create requests for unrelated branches.
  if [ "$import_expected" != "$import_src" ]; then
    if [ "$import_expected" = - ] && [ "$open_mr_count" = 0 ]; then
      g push --atomic -o ci.skip -o merge_request.create -o merge_request.target=main \
        -o 'merge_request.title=Import GitHub main through reviewed MR' \
        --force-with-lease="$import_ref:" gitlab "$import_src:$import_ref" || push_failed 'GitLab отклонил создание import-ветки/MR'
    else
      g push --atomic -o ci.skip --force-with-lease="$import_ref:$import_expected" \
        gitlab "$import_src:$import_ref" || push_failed 'GitLab отклонил fast-forward import-ветки'
    fi
  fi
  if [ "$open_mr_count" = 0 ] && [ "$import_expected" != - ]; then
    if [ "${SYNC_APPLY:-0}" = 1 ]; then
      printf 'url = "%s"\nheader = "PRIVATE-TOKEN: %s"\nrequest = "POST"\nform-string = "source_branch=codexpro-sync/github-main-import"\nform-string = "target_branch=main"\nform-string = "title=Import GitHub main through reviewed MR"\nform-string = "remove_source_branch=false"\nfail\nsilent\nshow-error\noutput = "%s"\n' \
        "$mr_api_url" "$GITLAB_SYNC_TOKEN" "$repo/created-mr.json" | curl -K - || fail 'Import-ветка обновлена, но не удалось создать GitLab MR через API'
    fi
  fi
  if [ "${SYNC_APPLY:-0}" = 1 ]; then
    read_open_mr || fail 'Import-ветка опубликована, но не удалось проверить GitLab MR'
    [ "$open_mr_count" = 1 ] || fail 'Import-ветка опубликована, но открытый GitLab MR не подтверждён'
    set_source_branch_retention || fail 'MR создан, но безопасное сохранение import-ветки после merge не подтверждено'
    echo "sync-github: ожидает обычного merge request merge в GitLab main; source=$import_ref sha=$import_src${open_mr_url:+ url=$open_mr_url}"
  else
    echo "sync-github: dry-run; GitLab main import будет MR из $import_ref@$import_src"
  fi
fi
snapshot gitlab "$repo/gitlab.all.after"
snapshot github "$repo/github.all.after"
awk -v internal="$import_ref" '$2 != internal' "$repo/gitlab.all.after" > "$repo/gitlab.after"
cp "$repo/github.all.after" "$repo/github.after"
if grep -q '^gitlab-import ' "$repo/plan"; then
  awk '$2 != "refs/heads/main"' "$repo/gitlab.after" > "$repo/gitlab.non-main.after"
  awk '$2 != "refs/heads/main"' "$repo/github.after" > "$repo/github.non-main.after"
  cmp -s "$repo/gitlab.non-main.after" "$repo/github.non-main.after" || fail 'После import остаются отличия вне main; проверьте receipts'
  lab_main=$(awk '$2 == "refs/heads/main" {print $1}' "$repo/gitlab.after")
  hub_main=$(awk '$2 == "refs/heads/main" {print $1}' "$repo/github.after")
  g merge-base --is-ancestor "$lab_main" "$hub_main" || fail 'После import main изменился неожиданно; нужен новый запуск'
  [ "$import_src" = "$hub_main" ] || fail 'GitHub main изменился после планирования import; нужен новый запуск'
else
  cmp -s "$repo/gitlab.after" "$repo/github.after" || fail 'Итоговые refs отличаются; возможна конкурентная запись, нужен новый запуск'
  echo 'sync-github: подтверждено равенство всех пользовательских heads/tags'
fi
cat "$repo/gitlab.after"
