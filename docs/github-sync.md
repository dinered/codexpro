# Синхронизация main с GitHub

Ветка `main` GitLab `ai/codexpro` и GitHub `dinered/codexpro` синхронизируются в
обе стороны, чтобы работать по очереди: сначала в GitLab, потом на GitHub, потом
снова в GitLab (ai/codexpro#4). Синхронизируется только `main`; ветки задач
`task/*` остаются в GitLab.

## Как работает

Задание CI `sync-github` (`.gitlab-ci.yml`) запускает `tools/sync-github/sync.sh`:
забирает `main` с обеих сторон полностью (не shallow) и сравнивает.

| Состояние | Что делает задание |
| --- | --- |
| на GitHub ветки `main` нет | публикует туда `main` GitLab со всей историей |
| стороны равны | ничего |
| GitLab впереди | push в `main` GitHub |
| GitHub впереди | push в `main` GitLab |
| разошлись | ничего не меняет, задание красное, заметка в Issue #4 |

Push всегда без принудительной перезаписи: удалённая сторона примет только
fast-forward, даже если её успели изменить между fetch и push. Два запуска сразу
не пересекаются (`resource_group`).

Когда запускается: по расписанию раз в 180 минут, при каждом push в `main` GitLab
(то есть после слияния MR) и вручную — Build → Pipelines → Run pipeline, ветка
`main`. Пока не заданы оба токена (раздел «Настройка», шаг 4), задания в пайплайне
нет вовсе.

Где: на раннере с тегом из переменной `SYNC_RUNNER_TAG`, по умолчанию
`merge-train-smoke` — shell-раннер `vm124-shell`, на нём же идёт `smoke`. Нужны
`git`, `curl` и выход на `github.com:443`. Другой раннер — CI-переменная проекта
`SYNC_RUNNER_TAG`.

Токены — только в CI-переменных GitLab (masked, protected): ни в git, ни в чате,
ни в аргументах команд. Скрипт отдаёт их git через помощник учётных данных, а
curl — через конфиг на stdin, поэтому в командной строке и в журнале задания
видно только имя переменной.

## Настройка (оператор, один раз)

1. **Репозиторий на GitHub** — пустой и приватный, без README:

   ```sh
   gh repo create dinered/codexpro --private --description "Синхронизируется с GitLab ai/codexpro (main) заданием CI sync-github, ai/codexpro#4"
   ```

2. **PAT GitHub**: github.com → Settings → Developer settings → Personal access
   tokens → Fine-grained tokens → Generate new token.
   - Token name: `gitlab-sync-codexpro`; Expiration: Custom — `2027-10-01` (эта
     дата записана в `AGENTS.md`).
   - Repository access: Only select repositories → `dinered/codexpro`.
   - Permissions → Repository permissions → Contents: Read and write (Metadata:
     Read-only GitHub добавит сам).

   Значение сразу вставить в CI-переменную (шаг 4), в чат не присылать.

3. **Токен GitLab**: ai/codexpro → Settings → Access tokens → Add new token:
   имя `sync-github`, роль Maintainer, scopes `write_repository` и `api` (`api` —
   для заметки о расхождении), срок не больше года.

   Защита `main` сейчас: Allowed to push and merge — No one. Чтобы задание могло
   приносить в `main` правки с GitHub: Settings → Repository → Protected branches →
   `main` → Allowed to push and merge — бот этого токена, если ваша редакция
   GitLab даёт выбрать пользователя; иначе Maintainers (тогда пушить в `main`
   напрямую смогут и люди с ролью Maintainer). Это ослабление защиты `main` —
   решение оператора (нота 6773 в Issue #4).

4. **CI-переменные**: Settings → CI/CD → Variables → Add variable, для
   `GITHUB_SYNC_TOKEN` (PAT GitHub) и `GITLAB_SYNC_TOKEN` (токен GitLab):
   Visibility — Masked, Protect variable — да, Expand variable reference — нет.

5. **Расписание**: Build → Pipeline schedules → New schedule: описание
   `sync-github`, Interval pattern — Custom `0 */3 * * *` (каждые 180 минут),
   Target branch — `main`, Active.

6. **Первый запуск**: Build → Pipelines → Run pipeline → `main`. В журнале
   задания `sync-github` — «на GitHub ветки main нет — первая публикация <SHA>»,
   задание зелёное. Ошибка вида «Could not resolve host» или таймаут до
   `github.com` — раннер не выходит в интернет: записать в Issue #4 и решать
   отдельно (прокси или другой раннер через `SYNC_RUNNER_TAG`).

## Работа по очереди

1. В GitLab — как раньше: ветка задачи, MR, слияние. После слияния push-пайплайн
   отправит `main` на GitHub за несколько минут.
2. Перед переходом на GitHub последнее задание `sync-github` должно быть зелёным;
   если сомневаетесь — Run pipeline.
3. На GitHub правки идут прямо в `main`.
4. Перед возвращением в GitLab — Run pipeline (иначе ждать расписания, до трёх
   часов). После зелёного задания `main` GitLab свежий; новые ветки задач —
   от него.

Пишет одна сторона за раз: при одновременных правках стороны разойдутся, и
синхронизация встанет.

## Расхождение

Признак: задание `sync-github` красное, в журнале «ветки main разошлись» с SHA
обеих сторон и общего предка, заметка в Issue #4. Ничего не перезаписано.

Свести вручную, без принудительного push: в клоне задачи GitLab забрать `main` с
GitHub и слить его в ветку задачи, затем MR:

```sh
git fetch https://github.com/dinered/codexpro.git main
git merge FETCH_HEAD
```

После слияния MR `main` GitLab содержит обе истории, и следующий запуск отправит
его на GitHub fast-forward.

## Перевыпуск PAT

До `2027-10-01`: новый PAT (шаг 2) → новое значение в `GITHUB_SYNC_TOKEN` →
новая дата в `AGENTS.md` (через MR). С истёкшим PAT задание красное с ошибкой
входа на GitHub.

## Риски

- Правки с GitHub приходят в `main` GitLab мимо MR, merge train и ревью — так
  решил оператор (нота 6773 в Issue #4).
- Токен GitLab с ролью Maintainer: его утечка даёт права мейнтейнера проекта.
- Раннер `vm124-shell` общий и выполняет задания shell-ом: пока идёт
  синхронизация, токены в окружении процесса доступны другим заданиям на нём под
  тем же пользователем. Для изоляции — отдельный раннер (`SYNC_RUNNER_TAG`).
- К `gitlab.home.arpa` токен идёт по http внутри локальной сети, как и весь
  остальной доступ к этому GitLab.

## Проверка (п. 8 Issue #4)

1. GitLab → GitHub: MR с небольшой правкой, слить; после push-пайплайна
   `main` на GitHub совпадает с GitLab по SHA.
2. GitHub → GitLab: правка в `main` на GitHub, Run pipeline; задание пишет
   «GitHub впереди», `main` GitLab совпадает с GitHub.
3. Расхождение: правка в `main` на GitHub и, до синхронизации, слияние MR в
   GitLab; Run pipeline — задание красное, заметка в Issue, `main` с обеих сторон
   не изменился; затем свести по разделу «Расхождение».
4. Итог — нотой в Issue #4 с SHA.

Скрипт без сети и токенов проверяется на двух локальных репозиториях:

```sh
sh tools/sync-github/sync.test.sh
```
