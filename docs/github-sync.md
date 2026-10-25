# Синхронизация GitLab и GitHub: все ветки и теги

Область: GitLab [`ai-company/codexpro`](http://gitlab.home.arpa/ai-company/codexpro)
и GitHub [`dinered/codexpro`](https://github.com/dinered/codexpro).
Скрипт `tools/sync-github/sync.sh` согласует **все `refs/heads/*` и `refs/tags/*`**
в обе стороны, вместе с достижимой историей Git. Ветки задач, в том числе старые
сохранённые ветки, входят в область. Исключены служебные refs GitLab MR/GitHub PR,
remote-tracking refs и прочие пространства refs.

Это недеструктивная синхронизация: отсутствующий ref восстанавливается с другой
стороны. Удаления и переписывание истории не распространяются. Для синхронного
удаления нужен отдельный согласованный порядок; удаление ветки на одном сервере
само по себе не является таким поручением.

Issues, MR/PR, комментарии, CI/pipeline history, настройки проекта, права,
секреты, releases/их вложения, Git LFS payloads, wiki и подмодули как отдельные
репозитории этим скриптом не переносятся. Git tag объекта release и Git LFS
pointer входят в Git; остальные данные требуют отдельной миграции.

## Алгоритм и гарантии

1. Полный fetch пользовательских веток и тегов обеих сторон в новый bare repo.
   Зарезервированная GitLab import-ветка `refs/heads/codexpro-sync/github-main-import`
   проверяется отдельно и исключается из пользовательского inventory. Такой ref на
   GitHub считается ошибкой. Список остальных полученных refs должен совпасть с
   исходным `ls-remote`.
2. Общий план по объединению refs обеих сторон:

   | Состояние ref | Действие |
   | --- | --- |
   | Отсутствует на одной стороне | Создать с тем же object ID |
   | Object ID равны | Ничего |
   | Одна вершина ветки — предок другой | Fast-forward отстающей стороны |
   | Ветки разошлись | Ошибка до первого push |
   | Одноимённые теги имеют разные object ID | Ошибка до первого push |

   Исключение для GitLab `main`: если GitHub `main` впереди, вместо push в
   защищённый `main` скрипт обновляет зарезервированную import-ветку и создаёт
   обычный MR в `main`. Branch updates используют FF/CAS. Существующий открытый MR
   переиспользуется; новый MR создаётся push options для первого ref или API для
   уже существующей ветки без открытого MR. Импортная ветка не входит в общий
   inventory и остаётся на GitLab после merge. При создании новой import-ветки
   используются [документированные push options GitLab](https://docs.gitlab.com/topics/git/commit/#push-options-for-merge-requests)
   `merge_request.create`, `merge_request.target=main` и фиксированный title. После
   создания API явно выставляет `remove_source_branch=false` и проверяет, что
   проект не принудительно удаляет source branch. Перед каждым запуском
   проверяется открытый MR для source/target: повторный push не
   передаёт `merge_request.create`, потому что это option создания нового MR, а не
   update существующего. Если import-ветка осталась после закрытого MR, API создаёт
   новый MR после FF/CAS с `remove_source_branch=false` через
   [Merge requests API](https://docs.gitlab.com/api/merge_requests/); повторный
   запуск видит уже открытый MR и использует его.
   До merge GitLab `main` намеренно отстаёт; job явно сообщает ожидание MR, не
   выдаёт это за равенство `main`.

   Annotated tags сравниваются по ID объекта тега, даже если целевой commit один.
   Ни конфликтующие теги, ни ветки автоматически не сводятся.
3. Перед публикацией всех новых объектов — ограниченный поиск известных форматов
   секретов в blob/commit/tag. При совпадении выводится только ID объекта, запуск
   останавливается до первого push. Это pattern-проверка, а не гарантия отсутствия
   секретов; перед первой внешней публикацией обязательна проверка всей исходящей
   истории ответственным за review. Не выводите потенциальные значения в журнал.
4. Повторная сверка обоих полных списков refs перед записью. Изменение источника,
   новая ветка или удаление требуют нового плана.
5. Один `git push --atomic` на сторону для обычных refs; import-ветка GitLab
   публикуется отдельным atomic push. Для каждого
   обновления — `--force-with-lease=<ref>:<expected-id>` как проверка ожидаемого
   значения (CAS). Перед этим независимо проверяется ancestry: допустимы только
   создание и fast-forward веток. Для существующих тегов push отсутствует.
   Lease **не разрешает** non-fast-forward или восстановление поверх чужого SHA.
   Пустой expected ID требует отсутствия ref. Если конкурент уже установил
   плановый SHA, Git может признать ref актуальным — это безопасное совпадение.
6. После записи — новый `ls-remote` обеих сторон и точное сравнение всех heads/tags.
   Успех apply означает подтверждённое равенство списков на момент проверки.

Общей транзакции между двумя серверами нет. При отказе второй стороны первая
может уже принять часть общего плана. Скрипт завершится с ошибкой, выведет
доступные актуальные refs обеих сторон и предложит повторную проверку. Успешные
fast-forward не откатываются. Устраните причину отказа и повторите весь запуск;
он пересчитает план. Недоступность receipts также явно выводится как ошибка
чтения, а не как отсутствие refs.

`resource_group: sync-github` сериализует CI-запуски. Ручные запуски и внешние push
этот lock не блокирует; expected-ID leases и итоговая сверка защищают от гонок.
Одновременная запись в одну ветку с обеих сторон может создать конфликт.

## CI и активация

Существующее задание `sync-github` заменено на полную синхронизацию; отдельного
старого main-only задания нет. Запуск при push убран: это исключает цикл от
входящих обновлений и выполнение синхронизации из недоверенной ветки задачи.
Источники запуска — только `schedule` и `web` на защищённой default-ветке `main`.
Входящий CI push в GitLab дополнительно передаёт `ci.skip`.

**Поставка кода не включает автоматизацию.** Для запуска deploy job нужны
`FULL_REPO_SYNC_ENABLED=true` и защищённый `main`. Если `GITLAB_SYNC_TOKEN` или
`GITHUB_SYNC_TOKEN` отсутствует, job теперь запускается и завершается до любого
Git fetch, называя только отсутствующие ключи. Значения, environment и trace не
выводятся.
`SYNC_APPLY` по умолчанию `0`: даже появившийся job сначала выполняет dry-run.
Зелёный dry-run подтверждает построение плана, а не синхронизацию.

Первое включение — после review MR и решения First Mate/Captain по конкретному
плану. Оператор с правами Maintainer:

1. Проверяет существующие credentials и разрешённые protected branches/tags в
   [Settings → Repository](http://gitlab.home.arpa/ai-company/codexpro/-/settings/repository).
   GitLab credential должен читать репозиторий, создавать/fast-forward обновлять
   обычные ветки и import-ветку, а также иметь API-доступ для чтения/создания MR и
   scoped reporting. Для GitLab `main` push credential не требуется: ветка
   обновляется только обычным review/merge request. Текущую защиту `main` с
   `push_access_levels: No one` сохраняем; скрипт не ослабляет её и не меняет роли.
2. В [CI/CD → Variables](http://gitlab.home.arpa/ai-company/codexpro/-/settings/ci_cd)
   проверяет `GITLAB_SYNC_TOKEN` и `GITHUB_SYNC_TOKEN`: masked, protected, без
   expansion; значения не передаёт агенту и не публикует. GitHub — доступ к
   `dinered/codexpro`, Contents read/write; при передаче `.github/workflows/*`
   GitHub может потребовать также разрешение Workflows. Недостаток подтверждается
   фактическим отказом сервера. Рабочие credentials без причины не перевыпускаются.
   Developer не видит все метаданные variables: отсутствие доступа не доказывает
   отсутствия переменных. Исторический срок PAT — `2027-10-01`; проверить у владельца.
3. После merge одобренной версии задаёт `FULL_REPO_SYNC_ENABLED=true` и запускает
   [Build → Pipelines → New pipeline](http://gitlab.home.arpa/ai-company/codexpro/-/pipelines/new),
   ref `main`, `SYNC_APPLY=0`. Проверяет план всех веток/тегов и исходящую историю.
4. Один ручной запуск `main`, `SYNC_APPLY=1`. Для входящего обновления GitHub `main`
   job создаёт/обновляет MR из `codexpro-sync/github-main-import` в GitLab `main`
   и явно сообщает, что ожидается обычное review и merge. Не включайте auto-merge и
   не удаляйте source branch. После merge повторный запуск синхронизирует новый
   GitLab `main` обратно на GitHub и проверяет равенство пользовательских refs.
   Сохраняйте URL pipeline/job, точный SHA source MR, результат CI и итоговые
   inventories с SHA в [Issue #4](http://gitlab.home.arpa/ai-company/codexpro/-/issues/4).
   Успех синхронизации main наступает только после обычного merge и последующей
   проверки обеих сторон; pending MR не является равенством.
5. Только после успешного apply создаёт активное расписание
   [Build → Pipeline schedules](http://gitlab.home.arpa/ai-company/codexpro/-/pipeline_schedules):
   `sync-github`, cron `0 */3 * * *`, UTC, target `main`, variable `SYNC_APPLY=1`.
   Проверяет первый scheduled job. До этого recurring execution выключено.

На проверке 2026-10-24 API schedules вернул `[]`; существование нужных secret
variables не установлено (их значения не запрашивались). У executor роль Developer.
`main` обеих сторон был `26850ace47147c8e68f10fe18da3ecc37c4c314b`, но наборы
веток различались. Это исходное наблюдение, а не результат нового apply.

Раннер по умолчанию `merge-train-smoke`, переопределяется `SYNC_RUNNER_TAG`.
Для production script нужны POSIX shell, git с поддержкой atomic push, curl,
обычные Unix utilities и доступ к обоим серверам. Для тестов достаточно тех же shell/Git utilities.
Никаких токенов в URL/argv/config со значениями: Git получает их из переменных
через credential helper, curl — через stdin. Используйте только URL без credentials.

## Конфликты и работа по очереди

Перед переходом между GitLab и GitHub дождитесь успешного **apply**, охватывающего
последнюю запись, либо попросите Maintainer выполнить ручной запуск; расписание
может задержать обновление до трёх часов. Ветки задач проходят обычный MR.
Оставленные после merge ветки продолжают синхронизироваться до отдельного решения
об их удалении. Вопрос «сколько веток должно остаться» не является фильтром скрипта.

При расхождении сохраните обе вершины. Ответственный готовит merge с сохранением
обоих предков и проводит его через MR; squash/rebase не сохраняют исходные SHA.
После согласованного merge обычный fast-forward сведёт стороны. Конфликт тегов
решается отдельно: выбор нового имени или перезапись требуют явного решения;
автоматический job существующий тег не меняет.

Правки с GitHub могут попадать в защищённые ветки GitLab напрямую только в рамках
согласованного оператором исключения для синхронизации. Скрипт не меняет доступы.
Учебное `#учебно-не-боевое-29`: исторически использовались широкий GitHub PAT,
GitLab credential с расширенными правами, общий shell runner и HTTP в локальной
сети. В production нужны узкие credentials, доверенный изолированный runner и TLS
([каталог](training-vs-production.md)). На общем shell runner секреты окружения
доступны другим заданиям того же пользователя — protected variables этого не устраняют.

## Почему расширен скрипт

Сначала проверено штатное [GitLab mirroring](https://docs.gitlab.com/user/project/repository/mirror/):
создание требует Maintainer; [двусторонний режим](https://docs.gitlab.com/user/project/repository/mirror/bidirectional/)
доступен в Premium/Ultimate и допускает конфликты. У [push mirror](https://docs.gitlab.com/user/project/repository/mirror/push/)
по умолчанию возможна перезапись diverged refs; нужен Keep divergent refs.
[Pull mirror](https://docs.gitlab.com/user/project/repository/mirror/pull/)
имеет отдельные правила обновления/удаления. Одновременная настройка двух зеркал
не даёт общего preflight всех refs и расписания существующего CI job.
Поэтому минимально расширен уже используемый скрипт, без новых сервисов и доступов.

После сообщения оператора «у нас enterprise» проверен установленный GitLab
`19.4.1-ee` на двух временных проектах, не связанных с codexpro. Pull mirror был
настроен с `mirror_overwrites_diverged_branches=false`. На источнике тег `release`
указывал на commit `e580bcc4a623a66d014643df0fbb0d381acf0f21`, а одноимённый тег
на приёмнике — на отдельный расходящийся commit
`e17385da658024c0877199cb8832063b4f73c684`. Ручной Pull mirror обновил тег
приёмника на SHA источника. Сам запуск завершился ошибкой, потому что default branch
также разошлась; однако тег уже был перемещён до этой ошибки. Текущая документация
Pull mirror обещает не обновлять divergent tags и branches, то есть фактический
результат не соответствует обещанию для тегов.

Это подтверждает риск на самом установленном GitLab, а не только на уровне Git CLI
или чтения исходников. `UpdateMirrorService` вызывает forced fetch до обработки
изменённых тегов; Gitaly передаёт `--force --tags`. Затем обработчик тегов вызывает
tag hooks, но не проверяет ancestry/divergence. Защищённые теги могут быть удалены
после проверки доступа, однако это не общий preflight конфликта refs: в probe
незащищённый одноимённый тег был заменён, несмотря на последующий отказ обновления
default branch.

Источники реализации: [GitLab `UpdateMirrorService`](https://gitlab.com/gitlab-org/gitlab/-/blob/v19.4.1-ee/ee/app/services/projects/update_mirror_service.rb),
[Gitaly `FetchRemote`](https://gitlab.com/gitlab-org/gitaly/-/blob/v19.4.1/internal/gitaly/service/repository/fetch_remote.go)
и [Gitaly flags для fetch](https://gitlab.com/gitlab-org/gitaly/-/blob/v19.4.1/internal/git/localrepo/remote.go).
Это противоречит [документации Pull mirror](https://docs.gitlab.com/user/project/repository/mirror/pull/).
Native bidirectional mirroring не удовлетворяет требованию остановить весь план при
любом конфликте тега и не может считаться безопасным без исправления GitLab или
дополнительного общего preflight перед обоими направлениями. До этого момента
встроенные зеркала codexpro остаются выключены.

## Локальная проверка

```sh
sh tools/sync-github/sync.test.sh
```

Тесты используют отдельные локальные bare repos и реальный Git: создание веток и
тегов с обеих сторон, fast-forward и сохранение предков, divergent branches,
конфликт тегов, гонки на источнике/получателе, atomic отказ и восстановление после
частичного межсерверного отказа, запрет публикации потенциального секрета.
