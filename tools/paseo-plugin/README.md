# Плагин Paseo «ChatGPT (CodexPro)»

Учебный плагин-провайдер для Paseo (ai/codexpro#2). В Paseo он выглядит как
ещё один агент — провайдер `codexpro`, модель `chatgpt`, — но сам не думает:
сообщение агенту кладёт в файл, а ответ берёт из файла. Кто напишет ответ —
человек, ChatGPT через CodexPro или мост `tools/chatgpt-bridge`, — плагину
всё равно.

## Как устроен

- `paseo-plugin.json` — паспорт плагина: имя `codexpro-worker`, нужная версия
  Paseo.
- `index.server.ts` — точка входа: регистрирует провайдера.
- `server/provider.ts` — сам провайдер. Paseo присылает ему запросы
  (`session.open`, `session.prompt`, `session.interrupt`, `session.close`), он
  отвечает событиями: сообщение в чат, ход начат, ход завершён.

Обмен идёт через папку `.ai-bridge/paseo/<сессия>/` в рабочей папке агента:

| Файл | Кто пишет | Что внутри |
| --- | --- | --- |
| `task.md` | плагин | ровно текст сообщения агенту |
| `reply.md` | человек, ChatGPT или мост | ответ |

Один ход:

1. Сообщение агенту → плагин пишет `task.md` и показывает в чате подсказку:
   что вставить в ChatGPT.
2. Раз в секунду плагин проверяет `reply.md`. Файл есть и перестал расти —
   текст уходит в чат как ответ агента, ход завершён, оба файла удаляются.
3. «Стоп» в Paseo → ход отменён, файлы удалены.

Ограничения прототипа: одна задача за раз в сессии; только текст; после
перезапуска демона Paseo ожидающий ход теряется.

## Запуск

Песочница Paseo в Docker и установка туда плагина — `tools/paseo-sandbox/README.md`.

Ответить на задачу вручную:

```sh
echo "Ответ" > ~/work/ai/codexpro/2/sandbox/.ai-bridge/paseo/<сессия>/reply.md
```

Отвечать через ChatGPT автоматически — `tools/chatgpt-bridge/README.md`.

## Тесты

```sh
cd tools/paseo-plugin && npm ci
npm test            # vitest: ответ имитируется записью файла
npm run typecheck   # проверка типов TypeScript
```

Тест через интерфейс Paseo — `tests/e2e`, см. `tools/chatgpt-bridge/README.md`.
