# Интеграция codexpro в Paseo: варианты

Issue ai/codexpro#1. Разбор по документации обоих проектов на 2026-10-06;
ничего не устанавливалось и не запускалось.

## Что есть что

**codexpro** ([rebel0789/codexpro](https://github.com/rebel0789/codexpro),
MIT, npm `codexpro` 0.30.x, Node 20+) — локальный MCP-сервер. Даёт
**веб-ChatGPT** (подписка оператора, плагин в Developer mode) доступ к
разрешённым репозиториям: чтение, поиск, правка, безопасный `bash`,
`show_changes`, запись планов в `.ai-bridge/`. ChatGPT ходит к серверу по
HTTPS, поэтому нужен туннель (Cloudflare, ngrok, Tailscale Funnel) и токен.
Режим `--mode handoff`: ChatGPT пишет план в `.ai-bridge/current-plan.md`,
исполняет его другой агент (`codexpro execute-handoff` — Codex, OpenCode, Pi)
и отчитывается в `.ai-bridge/agent-status.md`. `.git` для ChatGPT закрыт —
коммитит не он.

**Paseo** ([getpaseo/paseo](https://github.com/getpaseo/paseo), Apache-2.0)
у нас — control plane агентов (ai/Paseo-pilot): beta `0.11.0-beta.3` в
Docker на PVE, провайдеры Claude Code и Codex, worktree на задачу, роли
First Mate / CTO / Advisor. Точки расширения: CLI и SDK (`paseo run`,
`send`, `logs`), skills (`/paseo-handoff`, `/paseo-advisor`), плагины на
TypeScript (в том числе новые провайдеры), daemon сам является MCP-сервером.

**Главное различие.** Paseo запускает агентов-программы (CLI). codexpro
агента не содержит: «агент» — это ChatGPT в браузере, которым управляет
человек. Поэтому Paseo не может просто «запустить codexpro» как ещё одного
провайдера; стыковать их можно только через общий репозиторий или через
MCP.

## Варианты

| # | Вариант | Что даёт | Цена | Оценка |
|---|---------|----------|------|--------|
| 1 | Рядом, общий каталог | Captain правит/ревьюит тот же код из ChatGPT, пока агенты Paseo работают | Туннель + токен; ~30 мин | Основа для 2 |
| 2 | Handoff через `.ai-bridge/` | ChatGPT — планировщик/Advisor, агент Paseo — исполнитель, ревью снова в ChatGPT | Вариант 1 + промпт агенту; ~1–2 ч пилот | **Рекомендую** |
| 3 | ChatGPT управляет Paseo через MCP Paseo | ChatGPT сам запускает агентов Paseo | Это уже не codexpro; наружу открывается управление всеми агентами | Отложить |
| 4а | Провайдер-плагин «почтовый ящик» | codexpro виден в Paseo как воркер; задача и ответ — файлы в `.ai-bridge/` | ~150 строк TypeScript; шаг ChatGPT ручной | Учебный прототип |
| 4б | Мост Paseo → Playwright → ChatGPT | Ответ ChatGPT сам приходит в чат Paseo | Робот в веб-интерфейсе ChatGPT; риск для аккаунта | Только учебно, ручные прогоны (ai/codexpro#2, п. 6) |

### 1. Рядом, общий каталог

codexpro запускается с корнем в том же каталоге, где работает агент Paseo.
Оператор в ChatGPT читает, правит и проверяет код; агенты Paseo видят те же
файлы. Интеграционного кода нет.

Нюанс: Paseo создаёт worktree на задачу в `~/.paseo/worktrees/<id>/<имя>`,
а codexpro знает только заранее разрешённые корни (`codexpro settings set
--project ...`). Проще всего — агент Paseo в режиме local workspace на
каталоге, который уже разрешён в codexpro; либо добавлять worktree в
codexpro при старте задачи.

### 2. Handoff через `.ai-bridge/` (рекомендация)

```text
Captain ─ ChatGPT (codexpro, --mode handoff)
              │ пишет .ai-bridge/current-plan.md
              ▼
        Paseo: paseo run --provider codex/... (или claude/...)
              │ промпт = CODEX_PROMPT codexpro: выполнить план,
              │ писать .ai-bridge/agent-status.md
              ▼
        ChatGPT: show_changes, ревью → следующий план или ACCEPT
              ▼
        агент Paseo коммитит и ведёт MR (GitLab, как сейчас)
```

`codexpro execute-handoff` заменяется запуском агента в Paseo: исполнитель
получает worktree, логи, остановку и восстановление Paseo. Протокол
`.ai-bridge/` — простые markdown-файлы, его можно запустить вручную без
кода. Хорошо ложится на роль **Advisor** из архитектуры Paseo-pilot (§6):
второе мнение другой модели, причём модели из веб-подписки ChatGPT, которых
может не быть в Codex CLI.

Минусы: шаг ChatGPT всегда ручной (оператор пишет в чат) — это
полуавтоматическая петля, не автономная. `.ai-bridge/` нужно не забыть
исключить из MR или держать осознанно.

### 3. ChatGPT управляет Paseo через MCP Paseo

Daemon Paseo — MCP-сервер; теоретически его можно подключить к ChatGPT так
же, как codexpro. Тогда ChatGPT сам запускает и опрашивает агентов. Но это
интеграция ChatGPT↔Paseo без codexpro, и наружу через туннель выставляется
пульт управления всеми агентами и их авторизациями. Состав MCP-инструментов
Paseo не проверен. Возвращаться, если вариант 2 приживётся.

### 4. Провайдер-плагин Paseo

Провайдер Paseo ([provider plugins](https://github.com/getpaseo/paseo/blob/v0.11.0-beta.3/public-docs/plugins/providers.md))
принимает запросы (`session.prompt` и др.) и публикует события (сообщения в
чат, начало и конец хода). Откуда берётся ответ — его дело, модель вызывать
не обязательно.

**4а. «Почтовый ящик».** Сообщение агенту плагин пишет файлом задачи в
`.ai-bridge/` рабочей папки; оператор просит ChatGPT (через codexpro)
выполнить её и записать файл ответа; плагин видит ответ и публикует его в
чат Paseo. Для Paseo это обычный агент, ему можно делегировать. Шаг ChatGPT
ручной. Подходит как учебный прототип.

**4б. Мост в ChatGPT.** Скрипт на Mac (Playwright `connectOverCDP` к
Chrome оператора) берёт файл задачи плагина 4а, вводит текст в открытый чат
ChatGPT, ждёт конца ответа и пишет его в файл ответа. Хрупко, а условия
OpenAI запрещают программно извлекать ответы — риск для аккаунта. Поэтому
как постоянный транспорт не годится. С ок оператора сделан учебный мост
(ai/codexpro#2, п. 6): запуск только вручную, оператор рядом, не больше
500 коротких сообщений за запуск, новых чатов не открывает. Живой прогон
на длинном ответе прошёл.

## Риски и где запускать

- **Публичный вход в машину.** Туннель + `bash` + запись в репозиторий.
  Токен по умолчанию передаётся в URL (`?codexpro_token=`) — попадает в
  историю и логи; по SECURITY.md codexpro предпочитать заголовок, URL
  никому не передавать. Стабильный адрес — Tailscale Funnel или именованный
  туннель Cloudflare, не quick tunnel.
- **Где запускать.** Не в контейнере `paseo-beta`: там авторизации Claude и
  Codex, лишний радиус поражения. Варианты: (а) пилот на MacBook на тестовом
  репозитории; (б) отдельный контейнер `codexpro` на PVE, которому
  монтируется только рабочий каталог/worktree, без `~/.claude`/`~/.codex`.
- **Секреты.** Блок-лист codexpro закрывает `.env`, ключи, `.git`, но это
  не изоляция: всё, что лежит в разрешённом корне, доступно ChatGPT, то есть
  уходит в OpenAI.
- **Governance.** ChatGPT в `.git` не пишет — коммиты и MR остаются за
  агентами Paseo/executor, процесс Issue → MR не меняется.

## Не проверено

Проверено в ai/codexpro#2: codexpro работает в Docker (Linux) локально,
без туннеля.

- Хватает ли текущего тарифа ChatGPT оператора для Developer mode и
  custom-плагинов.
- Что делает `codexpro start --mode pro`.
- Набор MCP-инструментов daemon Paseo (для варианта 3).

## Предлагаемый пилот варианта 2 (отдельной задачей после слияния)

1. MacBook, тестовый репозиторий: `npm i -g codexpro`, `codexpro setup`,
   `codexpro start --mode handoff`, плагин в ChatGPT.
2. В ChatGPT: попросить план мелкой правки → появился
   `.ai-bridge/current-plan.md`.
3. `paseo run --provider codex/<модель>` в этом же каталоге с промптом
   «Read .ai-bridge/current-plan.md and execute it…» (CODEX_PROMPT codexpro).
4. В ChatGPT: `show_changes` + ревью `agent-status.md` → ACCEPT/правки.
5. Вердикт GO/NO-GO; при GO — решить, где жить codexpro (MacBook или
   отдельный контейнер на PVE).
