# codexpro-sandbox

codexpro (npm `codexpro@0.30.2`) в контейнере OrbStack: ChatGPT через туннель
видит только `/workspace` (= `~/work/ai/codexpro/2/sandbox`), а не Mac.
Внутри контейнера процесс идёт под `node` (uid 1000), не root.

Состояние (`~/.codexpro`: токен `http-token`, cloudflared) лежит на томе
`~/work/ai/codexpro/2/sandbox-codexpro/home` (0700) и переживает перезапуск.

## Сборка и создание (один раз)

```sh
cd tools/codexpro-sandbox && docker build -t codexpro-sandbox:0.30.2 .
B=~/work/ai/codexpro/2/sandbox-codexpro; mkdir -p $B/home && chmod 700 $B $B/home
# токен: сразу в файл 0600, на экран не попадает
docker run --rm -v $B/home:/home/node/.codexpro codexpro-sandbox:0.30.2 \
  sh -c 'umask 077; openssl rand -hex 32 > ~/.codexpro/http-token'
docker create --name codexpro-sandbox --init \
  -v ~/work/ai/codexpro/2/sandbox:/workspace -v $B/home:/home/node/.codexpro \
  codexpro-sandbox:0.30.2 codexpro start --root /workspace --tunnel cloudflare \
  --write workspace --bash safe --token-file /home/node/.codexpro/http-token \
  --headless --no-profile --no-copy-url
```

Корень `/workspace`, запись `workspace` (ChatGPT пишет файлы, в т.ч. в
`.ai-bridge/`), bash `safe`. Мастер `codexpro setup` не нужен — всё флагами.

## Запуск и остановка

```sh
docker start codexpro-sandbox      # поднимает codexpro и публичный туннель
docker stop codexpro-sandbox       # гасит всё, включая туннель
```

Адрес туннеля `trycloudflare.com` меняется при каждом старте. Токен в логах
печатается внутри Server URL — логи не показывать и не пересылать.

## Server URL в буфер обмена (на экран не выводится)

```sh
sleep 15; docker logs codexpro-sandbox 2>&1 | grep -o 'https://[^ ]*codexpro_token=[^ ]*' | tail -1 | pbcopy; [ -n "$(pbpaste)" ] && echo "буфер не пуст"
```

Пусто — туннель ещё не поднялся, повторить через несколько секунд.

## Chrome для ChatGPT

Обычный Chrome с отдельным профилем `~/work/ai/codexpro/2/sandbox-chrome/profile`
(вне git): оператор сам входит в ChatGPT, Playwright к этому окну только
подключается по CDP (протокол отладки Chrome). Открывать профиль из Playwright
(`launchPersistentContext`, `npx playwright open`) нельзя: Chrome под
автоматизацией выбивает вход в ChatGPT.

Перед запуском (`AGENTS.md`: только выход `FOREIGN_STRICT`):

```sh
curl -s --unix-socket /tmp/verge/verge-mihomo.sock http://localhost/proxies/FOREIGN \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["now"])'   # FOREIGN_STRICT, иначе не запускать
pgrep -f sandbox-chrome/profile    # пусто: второй Chrome на том же профиле не стартует
```

Запуск (порт `17891` — вход `foreign-shell` mihomo, группа `FOREIGN`):

```sh
nohup "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$HOME/work/ai/codexpro/2/sandbox-chrome/profile" \
  --proxy-server=socks5://127.0.0.1:17891 --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check https://chatgpt.com >/dev/null 2>&1 &
curl -s http://127.0.0.1:9222/json/version    # ответил — Chrome готов
```

CDP слушает `127.0.0.1`, но **контейнеры OrbStack до него достают**: OrbStack
пересылает их запросы на `host.docker.internal` (`0.250.250.254`) в
`127.0.0.1` Мака. Проверено 2026-10-06 из `paseo-sandbox`: `/json/version`
отвечает `200`. Пароля у CDP нет — значит, любой процесс в любом контейнере
может управлять этим Chrome: входом в ChatGPT и всеми его подключениями (в том
числе боевым `CodexPro` на ct116). Поэтому, пока этот Chrome запущен,
`codexpro-sandbox` (ChatGPT с bash) не запускать, а в `paseo-sandbox` не
создавать агентов, которые выполняют команды.

Флаг `--remote-allow-origins` не нужен: Playwright подключается без него, а `*`
снимает защиту от подключения со страниц сайтов.

Подключение из Playwright:

```js
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith("https://chatgpt.com"));
// ...
await browser.close();   // для CDP только отключается: Chrome и вход остаются (Playwright 1.63)
```

Остановить — Cmd+Q в этом окне Chrome. Процесс не убивать посреди работы.

## Подключение в ChatGPT

1. Settings → Security and login → Developer mode — включить.
2. Settings → Plugins → «Добавить» → «Создать пользовательский сервер MCP» →
   имя `CodexPro Sandbox`, Server URL — вставить из буфера, Authentication:
   None (авторизация — токен в URL).

Имя `CodexPro Sandbox`, а не `CodexPro`: в аккаунте уже есть боевой `CodexPro`
(ct116). Подсказка Paseo называет именно `CodexPro Sandbox`; в тестовом чате
включать только его — иначе ChatGPT может писать файлы на ct116.

## Проверка без публичного туннеля

Замеры при сборке (`--tunnel none`, изнутри контейнера): MCP-эндпоинт
`http://127.0.0.1:8787/mcp`; формат при старте
`http://127.0.0.1:8787/mcp?codexpro_token=<токен>`; с `Authorization: Bearer
<токен>` → 200, без токена или с неверным → 401.
