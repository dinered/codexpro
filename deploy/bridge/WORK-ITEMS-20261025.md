# Web Bridge: контрольная точка исходников 2026-10-25

Продолжение существующего [Draft MR !22](http://gitlab.home.arpa/ai-company/codexpro/-/merge_requests/22),
поверх его исходной головы `0fb183368271fdee3477e9d134d9bec52e69714e`.
Изменения подготовлены для review; установка и живая приёмка не выполнены.
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
| [#3](http://gitlab.home.arpa/ai-company/codexpro/-/issues/3) supervised live harness | Существующее разрешённое направление; живая приёмка отложена. `tests/e2e` содержит прежние bridge/Paseo сценарии, отдельного проекта `live` и `docs/live-tests.md` в текущем дереве нет. | Полный harness/runbook по записанным требованиям ещё не доставлен. Реальный прогон требует разрешённого теста и разрешения вопроса старой очереди. |
| [#6](http://gitlab.home.arpa/ai-company/codexpro/-/issues/6) метаданные | Продолжено: provider передаёт в `task.text` тело штатного сообщения Paseo. Синтетические provider/protocol проверки добавлены. | Независимое review и установка provider; реальная пересылка этой ревизией не проверялась. |
| [#7](http://gitlab.home.arpa/ai-company/codexpro/-/issues/7) прежний ответ | Продолжено: per-send подтверждение нового user turn и принадлежащего ему assistant turn; негативный сценарий проведён через protocol-v3 engine. | Review, immutable image/config packet, отдельная runtime-приёмка. Открытый production дефект пока не объявляется исправленным в установленной системе. |
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
это не доказательство живого поведения Chrome. Browser fixture обновлён для
нового identity-контракта, его запуск в этой среде недоступен.

Оба Dockerfile используют одинаковые актуальные reference checksums и шесть
overlays; в историческом `Dockerfile.paseo` устранены устаревшие pins и пропуски
idle/Send overlays. Docker image build и host installer не запускались.
Host installer/restart/security/profile migration остаются за отдельным review
архитектуры и конкретного runtime packet.

Проверка `node --test tools/docs-check/markers.test.mjs` выявила три существующих
сбоя на неизменённых файлах: пропуск раздела 24 в каталоге, пути `ChattyMy-bridge`
вместо `chatgpt-bridge`, неполная сводная таблица. Новые учебные упрощения и метки
этой поставкой не вводились. CI текущего проекта проверяет smoke/sync jobs,
поэтому его green отдельно не доказывает работоспособность Web Bridge.

По последнему handoff router приостановлен; старый cancel-only spool item
`20261025T120431Z-lcx5ms` не имеет acknowledged result. Его содержимое,
профиль, старые failed/cancelled turns и рабочий primary checkout сохраняются.
Возобновление/очистка очереди и реальный prompt в эту поставку не входят.
