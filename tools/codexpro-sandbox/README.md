# codexpro-sandbox

codexpro (npm `codexpro@0.30.2`) в контейнере OrbStack: файловые инструменты
ChatGPT через туннель видят только `/workspace` (= `~/work/ai/codexpro/2/sandbox`),
а не диск Мака. Внутри контейнера процесс идёт под `node` (uid 1000), не root.

Изоляция только файловая. По сети контейнер достаёт до всех сервисов на
127.0.0.1 Мака (`host.docker.internal`): CDP Chrome, прокси, демоны. А `--bash
safe` выполняет и скрипты пакетов (`npm test` и т. п.), то есть ChatGPT может
запустить в контейнере любой код, записав `package.json`. Поэтому
codexpro-sandbox и Chrome с CDP (раздел «Chrome для ChatGPT») одновременно не
работают.

Учебное упрощение `#учебно-не-боевое-18`: кроме `/workspace`, на запись примонтирован
том `~/.codexpro` с токеном и cloudflared — под тем же пользователем, под которым
`--bash safe` выполняет команды ChatGPT; cloudflared скачивается при старте и в образ не
входит. В бою — сетевая политика «запрещено всё, кроме нужного», ФС только для чтения,
секреты только для чтения у другого пользователя, все исполняемые файлы в образе ([`docs/training-vs-production.md`](../../docs/training-vs-production.md)).

Учебное упрощение `#учебно-не-боевое-16`: через этот контейнер ChatGPT из личного
аккаунта оператора читает весь `/workspace` — его файлы уходят в OpenAI на условиях
личной подписки. В бою — договор организации об обработке данных и в доступном модели
корне только разрешённое.

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
# поднимает codexpro и публичный туннель; не запускается, пока открыт Chrome с CDP
curl -s -m 2 http://127.0.0.1:9222/json/version >/dev/null \
  && echo "НЕ ЗАПУСКАТЬ: открыт Chrome с CDP (Cmd+Q в его окне)" || docker start codexpro-sandbox
docker stop codexpro-sandbox       # гасит всё, включая туннель
```

Адрес туннеля `trycloudflare.com` меняется при каждом старте. Токен в логах
печатается внутри Server URL — логи не показывать и не пересылать.

Учебное упрощение `#учебно-не-боевое-17`: токен в URL (он же сохранён в настройках
коннектора ChatGPT), временный туннель, ротации нет. В бою —
токен в заголовке `Authorization` из хранилища секретов, постоянный туннель со
входом по SSO, ротация ([`docs/training-vs-production.md`](../../docs/training-vs-production.md)).

## Server URL в буфер обмена (на экран не выводится)

```sh
sleep 15; docker logs codexpro-sandbox 2>&1 | grep -o 'https://[^ ]*codexpro_token=[^ ]*' | tail -1 | pbcopy; [ -n "$(pbpaste)" ] && echo "буфер не пуст"
```

Пусто — туннель ещё не поднялся, повторить через несколько секунд.

## Chrome для ChatGPT

Обычный Chrome с отдельным профилем `~/work/ai/codexpro/2/sandbox-chrome/profile`
(вне git): оператор сам входит в ChatGPT, Playwright к этому окну только
подключается по CDP (протокол отладки Chrome). Открывать профиль из Playwright
(`launchPersistentContext`, `npx playwright open`) нельзя: Chrome, запущенный
Playwright, разлогинивает ChatGPT. Вероятная причина — флаги Playwright
`--use-mock-keychain` и `--password-store=basic`, с которыми Chrome не может
расшифровать куки профиля (не проверено).

Перед запуском (`AGENTS.md`: только выход `FOREIGN_STRICT`; CDP открыт всё время,
пока работает этот Chrome, поэтому `codexpro-sandbox` проверяется уже здесь, а не
только мостом). Остальные контейнеры и машины OrbStack (`docker --context
orbstack ps`, `orb list`) тоже видят CDP: остановить их или принять риск явно.

```sh
curl -s --unix-socket /tmp/verge/verge-mihomo.sock http://localhost/proxies/FOREIGN \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["now"])'   # FOREIGN_STRICT, иначе не запускать
docker --context orbstack inspect -f '{{.State.Running}}' codexpro-sandbox 2>&1 \
  | grep -Eiqx 'false|error: no such object: .*' && echo "codexpro-sandbox не запущен" \
  || echo "НЕ ЗАПУСКАТЬ: codexpro-sandbox запущен или docker не ответил"
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

Учебное упрощение `#учебно-не-боевое-14`: CDP без пароля на общей машине. В бою
браузера нет вовсе, а если он нужен — отдельная машина без других жильцов
([`docs/training-vs-production.md`](../../docs/training-vs-production.md)).

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

Только в обычном браузере или профиле без CDP — не в Chrome моста: пока работает
codexpro-sandbox, CDP открыт быть не должен (шапка этого README).

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
