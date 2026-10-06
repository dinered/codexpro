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

## Подключение в ChatGPT

1. Settings → Security and login → Developer mode — включить.
2. Settings → Plugins → «+» → имя `CodexPro`, Server URL — вставить из буфера,
   Authentication: None (авторизация — токен в URL).

## Проверка без публичного туннеля

Замеры при сборке (`--tunnel none`, изнутри контейнера): MCP-эндпоинт
`http://127.0.0.1:8787/mcp`; формат при старте
`http://127.0.0.1:8787/mcp?codexpro_token=<токен>`; с `Authorization: Bearer
<токен>` → 200, без токена или с неверным → 401.
