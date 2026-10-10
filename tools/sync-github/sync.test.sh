#!/bin/sh
# Проверка sync.sh на двух локальных голых репозиториях вместо GitLab и GitHub — все исходы:
# первая публикация, стороны равны, GitLab впереди, GitHub впереди, расхождение (ничего не тронуто).
# Запуск: sh tools/sync-github/sync.test.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
git init -q --bare "$t/gl.git"
git init -q --bare "$t/gh.git"
git init -q "$t/w"
EMPTY=$(git -C "$t/w" hash-object -t tree /dev/null) # пустое дерево: коммитам нужны только родители и сообщения

mk() { # $1 — родитель (пусто — первый коммит), $2 — сообщение; печатает SHA
  GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid \
    git -C "$t/w" commit-tree ${1:+-p "$1"} -m "$2" "$EMPTY"
}
put() { git -C "$t/w" push -q -f "$t/$1.git" "$2:refs/heads/main"; } # состояние стороны для сценария
head_of() { git --git-dir="$t/$1.git" rev-parse -q --verify refs/heads/main || true; }
sync() { GITLAB_REPO_URL="file://$t/gl.git" GITHUB_REPO_URL="file://$t/gh.git" SYNC_NOTE_ISSUE= ${SH:-sh} "$here/sync.sh"; }
check() { [ "$2" = "$3" ] || { echo "НЕ ТАК: $1: ждали $3, вышло $2" >&2; exit 1; }; }

A=$(mk "" A) && put gl "$A"
sync >/dev/null
check "первая публикация на пустой GitHub" "$(head_of gh)" "$A"

sync >/dev/null
check "стороны равны: GitLab" "$(head_of gl)" "$A"
check "стороны равны: GitHub" "$(head_of gh)" "$A"

B=$(mk "$A" B) && put gl "$B"
sync >/dev/null
check "GitLab впереди — GitHub догоняет" "$(head_of gh)" "$B"

C=$(mk "$B" C) && put gh "$C"
sync >/dev/null
check "GitHub впереди — GitLab догоняет" "$(head_of gl)" "$C"

D=$(mk "$C" D) && put gl "$D"
E=$(mk "$C" E) && put gh "$E"
if sync >/dev/null 2>"$t/err"; then
  echo "НЕ ТАК: расхождение прошло без ошибки" >&2
  exit 1
fi
check "расхождение: GitLab не тронут" "$(head_of gl)" "$D"
check "расхождение: GitHub не тронут" "$(head_of gh)" "$E"
grep -q "разошлись" "$t/err" || { echo "НЕ ТАК: нет сообщения о расхождении" >&2; exit 1; }

echo "sync.sh: все исходы верны — первая публикация, равны, GitLab впереди, GitHub впереди, расхождение"
