# #учебно-не-боевое-18 — образ по тегу, пакеты apt без версий, зависимости codexpro без lock-файла, cloudflared не в образе
# (codexpro скачивает его при старте на том): пересборка даёт другие версии. В бою — образ по дайджесту, закреплённые
# версии, все исполняемые файлы в образе, сканирование и подпись (docs/training-vs-production.md).
FROM node:22-slim
# openssl: токен; curl: проверки; ca-certificates: cloudflared скачивается при старте
RUN apt-get update && apt-get install -y --no-install-recommends openssl curl ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g codexpro@0.30.2
# образ node уже содержит пользователя node (uid 1000)
USER node
ENV HOME=/home/node
WORKDIR /workspace
