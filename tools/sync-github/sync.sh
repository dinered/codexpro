#!/bin/sh
# Синхронизация ветки main между GitLab и GitHub в обе стороны, только fast-forward (ai/codexpro#4).
# Кто впереди — того и догоняем; стороны равны — ничего; разошлись — ничего не трогаем, код выхода 1
# (задание CI красное) и заметка в Issue. Принудительного push нет: без «+» удалённая сторона примет
# только fast-forward, даже если между fetch и push её успели изменить.
#
# Окружение:
#   GITLAB_REPO_URL, GITHUB_REPO_URL — адреса репозиториев (в тесте — file://);
#   GITLAB_SYNC_TOKEN, GITHUB_SYNC_TOKEN — токены (CI-переменные masked и protected; без них — без входа);
#   SYNC_BRANCH — ветка, по умолчанию main;
#   SYNC_NOTE_ISSUE — IID Issue для заметки о расхождении (пусто — без заметки);
#   CI_API_V4_URL, CI_PROJECT_ID, CI_PIPELINE_URL — задаёт GitLab CI.
set -eu
export GIT_TERMINAL_PROMPT=0 # нет входа — ошибка сразу, а не ожидание ввода в CI

: "${GITLAB_REPO_URL:?нужен адрес GitLab}" "${GITHUB_REPO_URL:?нужен адрес GitHub}"
branch=${SYNC_BRANCH:-main}

repo=$(mktemp -d)
trap 'rm -rf "$repo"' EXIT
git init -q --bare "$repo"
g() { git --git-dir="$repo" "$@"; }

# Токены — через помощник учётных данных: в argv и в журнал задания попадает только имя переменной.
origin() { printf '%s\n' "$1" | sed -E 's#^([a-z]+://[^/]+).*#\1#'; }
g config credential.helper "" # помощники раннера не берём
if [ -n "${GITLAB_SYNC_TOKEN:-}" ]; then
  g config "credential.$(origin "$GITLAB_REPO_URL").helper" \
    '!f() { [ "$1" = get ] && printf "username=sync\npassword=%s\n" "$GITLAB_SYNC_TOKEN"; }; f'
fi
if [ -n "${GITHUB_SYNC_TOKEN:-}" ]; then
  g config "credential.$(origin "$GITHUB_REPO_URL").helper" \
    '!f() { [ "$1" = get ] && printf "username=x-access-token\npassword=%s\n" "$GITHUB_SYNC_TOKEN"; }; f'
fi

# Заметка о расхождении в Issue; токен — в конфиге curl на stdin, не в argv.
note() {
  [ -n "${SYNC_NOTE_ISSUE:-}" ] && [ -n "${GITLAB_SYNC_TOKEN:-}" ] || return 0
  printf 'url = "%s/projects/%s/issues/%s/notes"\nheader = "PRIVATE-TOKEN: %s"\nform-string = "body=%s"\nfail\nsilent\nshow-error\noutput = "/dev/null"\n' \
    "$CI_API_V4_URL" "$CI_PROJECT_ID" "$SYNC_NOTE_ISSUE" "$GITLAB_SYNC_TOKEN" "$1${CI_PIPELINE_URL:+ Пайплайн: $CI_PIPELINE_URL}" |
    curl -K -
}

# Полный fetch, не shallow: на пустой GitHub уходит вся история.
g fetch -q --no-tags "$GITLAB_REPO_URL" "+refs/heads/$branch:refs/sync/gitlab"
lab=$(g rev-parse refs/sync/gitlab)
heads=$(g ls-remote --heads "$GITHUB_REPO_URL" "refs/heads/$branch") # сбой сети или входа — выход по set -e
hub=
if [ -n "$heads" ]; then
  g fetch -q --no-tags "$GITHUB_REPO_URL" "+refs/heads/$branch:refs/sync/github"
  hub=$(g rev-parse refs/sync/github)
fi

push() { # $1 — куда, $2 — коммит, $3 — что происходит
  echo "sync-github: $3"
  g push -q "$1" "$2:refs/heads/$branch"
}

if [ -z "$hub" ]; then
  push "$GITHUB_REPO_URL" "$lab" "на GitHub ветки $branch нет — первая публикация $lab"
elif [ "$lab" = "$hub" ]; then
  echo "sync-github: стороны равны ($lab)"
elif g merge-base --is-ancestor "$hub" "$lab"; then
  push "$GITHUB_REPO_URL" "$lab" "GitLab впереди: GitHub $hub → $lab"
elif g merge-base --is-ancestor "$lab" "$hub"; then
  push "$GITLAB_REPO_URL" "$hub" "GitHub впереди: GitLab $lab → $hub"
else
  base=$(g merge-base "$lab" "$hub" || echo нет)
  msg="sync-github: ветки $branch разошлись — GitLab $lab, GitHub $hub, общий предок $base. Ничего не изменено; свести вручную: docs/github-sync.md, «Расхождение»."
  echo "$msg" >&2
  note "$msg" || echo "sync-github: заметку в Issue $SYNC_NOTE_ISSUE записать не удалось" >&2
  exit 1
fi
