# Web Bridge: контрольная точка исходников 2026-10-25

Продолжение существующего [Draft MR !22](http://gitlab.home.arpa/ai-company/codexpro/-/merge_requests/22),
поверх его исходной головы `0fb183368271fdee3477e9d134d9bec52e69714e`.
Изменения `52a07ce` установлены: два последовательных сообщения, включая
многострочное, прошли живую приёмку в одном чате Chrome/Paseo. Точные identities
и границы проверки — [DEPLOYMENT-STATUS.md](DEPLOYMENT-STATUS.md).
Текущая целевая архитектура по последнему поручению — отдельные browser/router
containers и native provider Paseo. Сохранённый вариант `Dockerfile.paseo`,
entrypoint и host installer — историческая альтернатива; её запуск не согласован.

## Сверка существующих задач

Открытый статус issue сам по себе не означает отсутствие реализации.
У-1…У-7 уже вошли в reference v3.2.1 через GitHub PR10 (`58bd57c`) и GitLab
MR !15 (`16797daa`); MR !9 (`310f926`) содержит прежнюю deploy/provider основу.
Ни одна issue этой поставкой автоматически не закрывается.

| GitLab issue | Классификация и подтверждённое состояние | Остаток |
| --- | --- | --- |
| [#3](http://gitlab.home.arpa/ai-company/codexpro/-/issues/3) supervised live harness | Два разрешённых реальных сообщения прошли в новом чате, включая multiline; DOM и protocol ack сверены. | Полный harness/runbook по исходным требованиям ещё не доставлен; ограниченный live-прогон его не заменяет. |
| [#6](http://gitlab.home.arpa/ai-company/codexpro/-/issues/6) метаданные | Exact provider `52a07ce` установлен. Оба реальных `task.text` совпали с исходными сообщениями, служебной обёртки нет, multiline сохранён. | Все способы пользовательского ввода живым прогоном не покрыты; synthetic quoting/notification проверки сохранены. |
| [#7](http://gitlab.home.arpa/ai-company/codexpro/-/issues/7) прежний ответ | Exact image `71d5e66f…` установлен. Два последовательных сообщения получили свои новые ответы в том же чате; новый DOM turn и trace-matched ack подтверждены. | Умышленно неотправленный второй запрос проверен packaged synthetic regression; живого отказа Enter не провоцировали и не повторяли. |
| [#8](http://gitlab.home.arpa/ai-company/codexpro/-/issues/8) У-1 | Уже реализовано в reference: кандидаты challenge, видимость, `/auth/login`, unit/contract tests. | Полная browser-проверка каждого реального артефакта отсутствует; native binding также может отклонить навигацию до детектора challenge. |
| [#9](http://gitlab.home.arpa/ai-company/codexpro/-/issues/9) У-2 | Уже реализовано в reference: свой origin + `/backend-api/`, 403/429, fatal CHALLENGE, off по умолчанию; contract test 19. | `runtime/router.ts` пока передаёт `probe: null`, поэтому включение `network_probe` в native router не подключает этот механизм. 30x burst из предложения также не реализован. Новая интеграция в эту контрольную точку не добавлена. |
| [#10](http://gitlab.home.arpa/ai-company/codexpro/-/issues/10) У-3 | Уже реализовано: instant/chunks, единый бюджет набора, сверка Ф-4, отмена/challenge между порциями; `BoundDriver.appendText` проверяет привязку каждой порции. | Живой chunks-прогон не выполнялся; по умолчанию instant. |
| [#11](http://gitlab.home.arpa/ai-company/codexpro/-/issues/11) У-4 | Уже реализовано: обычный stop click с timeout и нефатальным отказом, два unit tests. | Дополнительная живая приёмка не выполнялась. Это У-4, а не дубль GitLab #7; GitHub #11 имеет другую нумерацию. |
| [#12](http://gitlab.home.arpa/ai-company/codexpro/-/issues/12) У-5 | Уже доставлено: reference README «Запуск» / «Что видит платформа» и ссылка из CDP connection error в `src/main.ts`. | Решение о закрытии после сверки требований остаётся за владельцем; новая документационная фича не требуется. |
| [#13](http://gitlab.home.arpa/ai-company/codexpro/-/issues/13) У-6 | Уже реализованы counters challenge/rateLimit/backoff, безопасная запись и tests состава файла. | Это накопительные counters, отдельное временное окно не введено. Для native router действует ограничение probe из #9. |
| [#14](http://gitlab.home.arpa/ai-company/codexpro/-/issues/14) У-7 | Уже реализовано: `Pacer.snapshot(now).backoffUntilMs` содержит конец действующей паузы и становится null после неё; unit test. | Повторная реализация не нужна; issue оставлена открытой для решения владельца. |
| [#15](http://gitlab.home.arpa/ai-company/codexpro/-/issues/15) импорт web history | Не начато, feature request для отдельного scope decision. Native provider сейчас получает только результаты своих задач. | Нужен согласованный контракт фонового импорта в Paseo, дедупликации/происхождения и восстановления; фоновый scraper этой поставкой не создаётся. |

## Изменение #7

До единственного Enter снимается baseline идентификаторов `data-turn-key:role`.
После него принимается ровно один новый user turn с ожидаемым текстом и пустым
видимым composer. Подтверждение ограничено десятью секундами и проверяется в
штатных опросах engine, где продолжают работать cancel/alive/stop guards.
Ответ берётся только из следующего нового assistant turn. Идентичность
проверяется отдельно от текста: одинаковые ответы на два запроса допустимы.
Доказательства и HTML читаются одним сериализуемым DOM evaluator.

После независимого review добавлена регрессия многострочного contenteditable:
`<br>` и блочные переносы читаются через `innerText`, согласованно с драйвером;
`textContent` склеивал строки и ошибочно блокировал корректный ввод. Оба DOM-варианта
проходят с одной отправкой, а изменение второй строки отклоняется до Enter.

Отсутствующие/повторяющиеся идентификаторы, другой user turn или неопределённая
отправка дают явную ошибку без автоматического resend. Journal, target/origin/
conversation/exclusivity, stable-answer, no-stop/no-streaming и idle controls
сохранены. Cancel проверяет реальное состояние остановки, не ожидая подтверждения
неотправленного запроса. Черновик после неясной отправки сохраняется для оператора.
Изменение DOM-контракта платформы требует review селекторов; эвристического
принятия старого ответа при отсутствии идентичности нет.

## Изменение #6

Источник установлен по коду Paseo 0.12: `prepareAgentMessage` / `formatAgentMessage`
в `server/agent/agent-messages` и `plugin-provider.startTurn`. В provider API нет
отдельного поля origin: происхождение представлено versioned XML envelope,
а его `message-id` передаётся как `clientMessageId`. Human send path оборачивает
буквально введённые зарезервированные envelopes в `kind="user-message"`.

Снимается ровно один штатный слой XML escaping. `agent-message` передаёт тело;
`agent-notification` и legacy system notification отклоняются до записи задачи.
Несовпадающий message ID также отклоняется. Обычный текст и текст, только похожий
на metadata, не обрезаются. Native timeline echo сохраняет исходный envelope:
Paseo продолжает распознавать происхождение, очищается только текст web-задачи.
Синтетическая сверка с установленным `prepareAgentMessage` прошла пять случаев.

## Проверки и границы поставки

`sh deploy/bridge/check.sh` проверяет patched reference, deployment TypeScript,
binding/serialization/provider-engine/Send/submission fixtures. Тест #7 использует
сериализованный evaluator и DOM fixture, затем настоящий protocol-v3 engine;
это не доказательство живого поведения Chrome. Обновлённый per-chat-browser fixture
в этой поставке не повторялся; отдельная живая приёмка двух сообщений описана
в текущем [статусе установки](DEPLOYMENT-STATUS.md).

Оба Dockerfile используют одинаковые актуальные reference checksums и шесть
overlays; в историческом `Dockerfile.paseo` устранены устаревшие pins и пропуски
idle/Send overlays. Sidecar image `71d5e66f…` собран и проверен nonroot;
17 packaged regressions PASS. Provider и только router обновлены по прямому
поручению оператора, браузер и Paseo сохранены. Host installer исторической
all-in альтернативы не запускался.

Проверка `node --test tools/docs-check/markers.test.mjs` выявила три существующих
сбоя на неизменённых файлах: пропуск раздела 24 в каталоге, пути `ChattyMy-bridge`
вместо `chatgpt-bridge`, неполная сводная таблица. Новые учебные упрощения и метки
этой поставкой не вводились. CI текущего проекта проверяет smoke/sync jobs,
поэтому его green отдельно не доказывает работоспособность Web Bridge.

Router сообщает ready. По прямому разрешению оператора старый cancel-only
item `20261025T120431Z-lcx5ms` перенесён из spool в quarantine: три файла и
их hashes сохранены, fake ack/result не создавались. Все 107 файлов 15 старых
acknowledged задач сохранены; ровно два новых реальных теста завершились ok.
Устаревший общий запрет в active brief снят оператором; повторные согласования
рутинных обратимых действий в текущем объёме не требуются. Технические учебные
предохранители, limits и отказ от resend сохранены.
