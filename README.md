# codexpro

Учебный проект: как встроить веб-ChattyMy в Paseo, систему управления
агентами. Плагин делает ChattyMy в Paseo ещё одним агентом. Ответы ему
пишет мост, человек или сам ChattyMy через CodexPro. Проект учебный; «боевое»
в документации — образец для сравнения, а не план. Код и документация при этом — по высшим отраслевым стандартам
(`AGENTS.md`): с учениками каждый аспект разбирается как с senior-инженерами.

Заведено `ai-project ensure`. Канон правил и договорённости с оператором —
[`AGENTS.md`](AGENTS.md).

## Из чего состоит

```text
Paseo: агент codexpro/ChattyMy (плагин codexpro-worker)
   │ пишет task-<id>.md                ▲ читает reply-<id>.md или error-<id>.md
   ▼                                   │
.ai-bridge/paseo/<сессия>/   — протокол v2, tools/paseo-plugin/server/protocol.ts
   │ захват claim-<id>                 ▲ ответ в markdown
   ▼                                   │
мост ChattyMy-bridge — запускается автоматом
   │ вводит текст по CDP               ▲ читает ответ со страницы
   ▼                                   │
Chrome оператора: открытые чаты по проектам ChattyMy.com/c/…
```

| Каталог | Что это |
| --- | --- |
| [`tools/paseo-plugin`](tools/paseo-plugin/README.md) | плагин-провайдер Paseo «ChattyMy (CodexPro)» и протокол обмена файлами v2 |
| [`tools/ChattyMy-bridge`](tools/ChattyMy-bridge/README.md) | учебный мост Paseo → ChattyMy через Playwright; предохранители и чек-лист живого прогона |
| [`tools/paseo-sandbox`](tools/paseo-sandbox/README.md) | песочница Paseo в Docker с плагином |
| [`tools/codexpro-sandbox`](tools/codexpro-sandbox/README.md) | codexpro в контейнере и Chrome для ChattyMy |
| [`tests/e2e`](tests/e2e/playwright.config.ts) | тесты Playwright: мост на имитации ChattyMy и цепочка через Paseo |
| [`tools/docs-check`](tools/docs-check/markers.test.mjs) | сверка каталога «учебно или боевое» с метками в коде |
| `tools/sync-github` | синхронизация `main` с GitHub (задание CI `sync-github`) |

## Документация

- [Учебная реализация и боевая](docs/training-vs-production.md): чем каждое
  решение отличается от боевого, почему так и чем грозит. Начинать разбор с
  учениками — отсюда.
- [Варианты интеграции codexpro в Paseo](docs/integration-options.md).
- [Синхронизация main с GitHub](docs/github-sync.md).

## Метки в коде

| Метка | Что отмечает |
| --- | --- |
| `#внимание-учебно-аналитический-предохранитель` | ограничение автоматизации ChattyMy: лимит, пауза, запрет, остановка |
| `#модельный-учебно-аналитический-контроль` | место, где Claude сверяет, что работа не вышла за учебные рамки |
| `#учебно-не-боевое-NN` | решение, которое в боевой системе было бы другим; `NN` — раздел [каталога](docs/training-vs-production.md) |

```sh
git grep -n "#внимание-учебно"
git grep -n "#модельный-учебно"
git grep -n "#учебно-не-боевое"
```

## Тесты

Живой ChattyMy тестам не нужен: мост проверяется на имитации
`tests/e2e/fake-ChattyMy.html`, в сеть ничего не уходит. Из корня репозитория:

```sh
(cd tools/paseo-plugin && npm ci && npm test && npm run typecheck)   # протокол и плагин
(cd tools/ChattyMy-bridge && npm ci && npm run typecheck)             # типы моста
(cd tests/e2e && npm ci && npx playwright install chromium && npx playwright test --project bridge)  # мост на имитации
node --test tools/docs-check/markers.test.mjs                        # каталог и метки
sh tools/sync-github/sync.test.sh                                    # синхронизация main ⇄ GitHub на локальных репозиториях
```

Тест `--project paseo` нужен контейнер `paseo-sandbox`
(`tools/ChattyMy-bridge/README.md`, «Тесты»). В CI тесты не запускаются
(`docs/training-vs-production.md`, раздел 22). Мост на живом ChattyMy
запускается автоматом.
