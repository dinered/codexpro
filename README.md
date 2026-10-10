# codexpro

Учебный проект: как встроить веб-ChatGPT в Paseo, систему управления
агентами. Плагин делает ChatGPT в Paseo ещё одним агентом. Ответы ему
пишет мост, человек или сам ChatGPT через CodexPro. Проект учебный и боевым
не станет. Код и документация при этом — по высшим отраслевым стандартам
(`AGENTS.md`): с учениками каждый аспект разбирается как с senior-инженерами.

Заведено `ai-project ensure`. Канон правил и договорённости с оператором —
[`AGENTS.md`](AGENTS.md).

## Из чего состоит

```text
Paseo: агент codexpro/chatgpt (плагин codexpro-worker)
   │ пишет task-<id>.md                ▲ читает reply-<id>.md или error-<id>.md
   ▼                                   │
.ai-bridge/paseo/<сессия>/   — протокол v2, tools/paseo-plugin/server/protocol.ts
   │ захват claim-<id>                 ▲ ответ в markdown
   ▼                                   │
мост chatgpt-bridge — запускает человек вручную, под предохранителями
   │ вводит текст по CDP               ▲ читает ответ со страницы
   ▼                                   │
Chrome оператора: один открытый чат chatgpt.com/c/…
```

| Каталог | Что это |
| --- | --- |
| [`tools/paseo-plugin`](tools/paseo-plugin/README.md) | плагин-провайдер Paseo «ChatGPT (CodexPro)» и протокол обмена файлами v2 |
| [`tools/chatgpt-bridge`](tools/chatgpt-bridge/README.md) | учебный мост Paseo → ChatGPT через Playwright; предохранители и чек-лист живого прогона |
| [`tools/paseo-sandbox`](tools/paseo-sandbox/README.md) | песочница Paseo в Docker с плагином |
| [`tools/codexpro-sandbox`](tools/codexpro-sandbox/README.md) | codexpro в контейнере и Chrome для ChatGPT |
| [`tests/e2e`](tests/e2e/playwright.config.ts) | тесты Playwright: мост на имитации ChatGPT и цепочка через Paseo |
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
| `#внимание-учебно-аналитический-предохранитель` | ограничение автоматизации ChatGPT: лимит, пауза, запрет, остановка |
| `#модельный-учебно-аналитический-контроль` | место, где Claude сверяет, что работа не вышла за учебные рамки |
| `#учебно-не-боевое-NN` | решение, которое в боевой системе было бы другим; `NN` — раздел [каталога](docs/training-vs-production.md) |

```sh
git grep -n "#внимание-учебно"
git grep -n "#модельный-учебно"
git grep -n "#учебно-не-боевое"
```

## Тесты

Живой ChatGPT тестам не нужен: мост проверяется на имитации
`tests/e2e/fake-chatgpt.html`, в сеть ничего не уходит. Из корня репозитория:

```sh
(cd tools/paseo-plugin && npm ci && npm test && npm run typecheck)   # протокол и плагин
(cd tools/chatgpt-bridge && npm ci && npm run typecheck)             # типы моста
(cd tests/e2e && npm ci && npx playwright install chromium && npx playwright test --project bridge)  # мост на имитации
node --test tools/docs-check/markers.test.mjs                        # каталог и метки
sh tools/sync-github/sync.test.sh                                    # синхронизация main ⇄ GitHub на локальных репозиториях
```

Тест `--project paseo` нужен контейнер `paseo-sandbox`
(`tools/chatgpt-bridge/README.md`, «Тесты»). В CI тесты не запускаются
(`docs/training-vs-production.md`, раздел 22). Мост на живом ChatGPT
запускает только человек и только по слову оператора.
