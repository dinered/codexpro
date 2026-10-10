# Песочница Paseo 0.11.0-beta.5 с плагином codexpro

Docker (OrbStack), контейнер `paseo-sandbox`, порт только на localhost: `127.0.0.1:6790`.
Каталог песочницы `S=~/work/ai/codexpro/<issue>/sandbox-paseo` (вне git); рабочая папка агентов —
git-репозиторий `~/work/ai/codexpro/<issue>/sandbox` (в контейнере `/workspace`).

## Подъём с нуля

```sh
S=~/work/ai/codexpro/2/sandbox-paseo
mkdir -p $S/home $S/plugins
[ -e $S/paseo.env ] || (umask 077; echo "PASEO_PASSWORD=$(openssl rand -hex 24)" > $S/paseo.env)   # пароль не печатаем и не перезаписываем
rsync -a --exclude node_modules tools/paseo-plugin/ $S/plugins/codexpro-worker/
docker run -d --name paseo-sandbox -p 127.0.0.1:6790:6767 --env-file $S/paseo.env \
  -v $S/home:/home/paseo -v $S/../sandbox:/workspace -v $S/plugins:/plugins \
  ghcr.io/getpaseo/paseo:0.11.0-beta.5
docker inspect -f '{{.State.Health.Status}}' paseo-sandbox   # ждём healthy
```

Дальше `p` = `docker exec --user paseo paseo-sandbox` (от root в контейнере команды ставят файлы не тому владельцу).
Командам `paseo` демон указывается явно, `--host 127.0.0.1:6767`: в контейнере демон работает под
супервизором, и поиск «локального демона» по умолчанию его не находит (`Daemon is not running`).

## Включить плагины

В `/home/paseo/.paseo/config.json` (на хосте `$S/home/.paseo/config.json`) добавить корневое поле
`"pluginsEnabled": true`, затем:

```sh
docker exec --user paseo paseo-sandbox paseo reload --json --host 127.0.0.1:6767
```

## Установка и переустановка плагина

```sh
docker exec --user paseo paseo-sandbox paseo plugin install /plugins/codexpro-worker --host 127.0.0.1:6767
docker exec --user paseo paseo-sandbox paseo plugin ls --host 127.0.0.1:6767                     # running
docker exec --user paseo paseo-sandbox paseo plugin logs codexpro-worker --host 127.0.0.1:6767   # без ошибок
```

После правок кода: копия без `node_modules` и перезагрузка.

```sh
rsync -a --delete --exclude node_modules tools/paseo-plugin/ $S/plugins/codexpro-worker/
docker exec --user paseo paseo-sandbox paseo plugin reload codexpro-worker --host 127.0.0.1:6767
```

## Проверка через CLI

Не при работающем мосте `tools/chatgpt-bridge`: он отправит эту задачу в живой ChatGPT.

```sh
docker exec --user paseo paseo-sandbox paseo run -d --host 127.0.0.1:6767 --provider codexpro/chatgpt --cwd /workspace "Короткая задача"
ls $S/../sandbox/.ai-bridge/paseo/*/task-*.md                # задача появилась: <сессия>/task-<id>.md
echo "Ответ из песочницы" > $S/../sandbox/.ai-bridge/paseo/<сессия>/reply-<id>.md
docker exec --user paseo paseo-sandbox paseo logs <агент> --host 127.0.0.1:6767    # ответ есть, ход завершён
```

Без `-d` `paseo run` ждёт завершения хода, то есть появления `reply-<id>.md`.
Имена файлов и правила обмена — `tools/paseo-plugin/README.md`.

## Запуск, остановка и удаление

```sh
docker start paseo-sandbox         # запустить уже созданную песочницу
docker inspect -f '{{.State.Health.Status}}' paseo-sandbox   # ждём healthy
docker stop paseo-sandbox          # остановить (данные в home/ остаются)
docker rm -f paseo-sandbox         # удалить контейнер
rm -rf $S/home                     # сбросить состояние демона
```
