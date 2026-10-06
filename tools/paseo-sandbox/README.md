# Песочница Paseo 0.11.0-beta.5 с плагином codexpro

Docker (OrbStack), контейнер `paseo-sandbox`, порт только на localhost: `127.0.0.1:6790`.
Каталог песочницы `S=~/work/ai/codexpro/<issue>/sandbox-paseo` (вне git); рабочая папка агентов —
git-репозиторий `~/work/ai/codexpro/<issue>/sandbox` (в контейнере `/workspace`).

## Подъём с нуля

```sh
S=~/work/ai/codexpro/2/sandbox-paseo
mkdir -p $S/home $S/plugins
umask 077; echo "PASEO_PASSWORD=$(openssl rand -hex 24)" > $S/paseo.env   # пароль не печатаем
rsync -a --exclude node_modules tools/paseo-plugin/ $S/plugins/codexpro-worker/
docker run -d --name paseo-sandbox -p 127.0.0.1:6790:6767 --env-file $S/paseo.env \
  -v $S/home:/home/paseo -v $S/../sandbox:/workspace -v $S/plugins:/plugins \
  ghcr.io/getpaseo/paseo:0.11.0-beta.5
docker inspect -f '{{.State.Health.Status}}' paseo-sandbox   # ждём healthy
```

Дальше `p` = `docker exec --user paseo paseo-sandbox` (от root в контейнере команды ставят файлы не тому владельцу).

## Включить плагины

В `/home/paseo/.paseo/config.json` (на хосте `$S/home/.paseo/config.json`) добавить корневое поле
`"pluginsEnabled": true`, затем:

```sh
docker exec --user paseo paseo-sandbox paseo reload --json
```

## Установка и переустановка плагина

```sh
docker exec --user paseo paseo-sandbox paseo plugin install /plugins/codexpro-worker
docker exec --user paseo paseo-sandbox paseo plugin ls                     # running
docker exec --user paseo paseo-sandbox paseo plugin logs codexpro-worker   # без ошибок
```

После правок кода: копия без `node_modules` и перезагрузка.

```sh
rsync -a --delete --exclude node_modules tools/paseo-plugin/ $S/plugins/codexpro-worker/
docker exec --user paseo paseo-sandbox paseo plugin reload codexpro-worker
```

## Проверка через CLI

```sh
docker exec --user paseo paseo-sandbox paseo run -d --provider codexpro/chatgpt --cwd /workspace "Короткая задача"
ls $S/../sandbox/.ai-bridge/paseo/*/task.md                  # задача появилась
echo "Ответ из песочницы" > $S/../sandbox/.ai-bridge/paseo/<id>/reply.md
docker exec --user paseo paseo-sandbox paseo logs <агент>    # ответ есть, ход завершён
```

Без `-d` `paseo run` ждёт завершения хода, то есть появления `reply.md`.

## Остановка и удаление

```sh
docker stop paseo-sandbox          # остановить (данные в home/ остаются)
docker rm -f paseo-sandbox         # удалить контейнер
rm -rf $S/home                     # сбросить состояние демона
```
