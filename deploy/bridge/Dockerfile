FROM node:24.21.0-bookworm-slim

# Google Chrome Stable, not Playwright's bundled Chromium. Public upstream
# package and viewer archives are pinned by version and SHA-256.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl python3 patch tigervnc-standalone-server openbox \
      fonts-liberation fonts-noto-color-emoji util-linux \
 && curl -fsSL https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_156.0.8078.47-1_amd64.deb -o /tmp/chrome.deb \
 && echo '6c92cd22e90c6e3e255d782991543fa2091db8614e8536a971a7433a5c4d7ac8  /tmp/chrome.deb' | sha256sum -c - \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && curl -fsSL https://codeload.github.com/novnc/noVNC/tar.gz/refs/tags/v1.7.0 -o /tmp/novnc.tar.gz \
 && echo 'b1003a11b6e6e8d8f7f5e5586daae7f8ca651d8aee0aa155ff9ac841c48f52c6  /tmp/novnc.tar.gz' | sha256sum -c - \
 && mkdir /opt/novnc && tar -xf /tmp/novnc.tar.gz -C /opt/novnc --strip-components=1 \
 && curl -fsSL https://codeload.github.com/novnc/websockify/tar.gz/refs/tags/v0.13.0 -o /tmp/websockify.tar.gz \
 && echo 'b6413e364efd04f3c92ec8c17747e3c4adc20157c2ef1c5d019a26d944a46df8  /tmp/websockify.tar.gz' | sha256sum -c - \
 && mkdir /opt/websockify && tar -xf /tmp/websockify.tar.gz -C /opt/websockify --strip-components=1 \
 && rm /tmp/chrome.deb /tmp/novnc.tar.gz /tmp/websockify.tar.gz \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY docs/mydocs/z.ai/download/bridge-reference/ /app/
COPY deploy/bridge/read-page.patch deploy/bridge/idle-control.patch deploy/bridge/shutdown.patch deploy/bridge/router-step.patch deploy/bridge/send-label.patch deploy/bridge/submission.patch /tmp/
RUN echo '306eebd8f6a2a6d0fcd5c2d74c543c37f308065818c22a2ba5b7a604cd2a9c8e  src/driver/chatgpt.ts' | sha256sum -c - \
 && echo 'd156b2b674e4d65e217a839812f9a743b1b07fbb898998f49f603774947bd9a3  src/main.ts' | sha256sum -c - \
 && echo '30bdbb59c1dd429f630c38622741e11cd6a09f33e963247d3c98a5cc70416b47  src/bridge/loop.ts' | sha256sum -c - \
 && echo 'bbea0c7357b54c02fcd6cf690796884c2599a8ec8fedf79557e7e27851356763  selectors/chatgpt.yaml' | sha256sum -c - \
 && patch --batch --fuzz=0 -p1 < /tmp/read-page.patch \
 && patch --batch --fuzz=0 -p1 < /tmp/idle-control.patch \
 && patch --batch --fuzz=0 -p1 < /tmp/shutdown.patch \
 && patch --batch --fuzz=0 -p1 < /tmp/router-step.patch \
 && patch --batch --fuzz=0 -p1 < /tmp/send-label.patch \
 && patch --batch --fuzz=0 -p1 < /tmp/submission.patch \
 && rm /tmp/read-page.patch /tmp/idle-control.patch /tmp/shutdown.patch /tmp/router-step.patch /tmp/send-label.patch /tmp/submission.patch \
 && npm ci --ignore-scripts --omit=dev --no-audit --no-fund
COPY deploy/bridge/runtime/ /app/deployment/
COPY deploy/bridge/supervise.py deploy/bridge/health.py deploy/bridge/bridge deploy/bridge/router /opt/bridge/
RUN chmod 755 /opt/bridge/bridge /opt/bridge/router \
 && chmod -R a+rX /app /opt/bridge \
 && mkdir -p /home/node/profile /data/spool /data/control \
 && chown -R node:node /home/node/profile /data
ENV DISPLAY=:0 PYTHONPATH=/opt/websockify BRIDGE_SPOOL=/data/spool \
    BRIDGE_CDP_URL=http://127.0.0.1:9222
USER node
CMD ["python3", "/opt/bridge/supervise.py"]
