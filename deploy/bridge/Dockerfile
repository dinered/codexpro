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
COPY deploy/bridge/read-page.patch deploy/bridge/shutdown.patch deploy/bridge/router-step.patch /tmp/
RUN echo 'f3b28c68da9ff452e3180fab0075c4e6b4dff79003091e32b948f348c164e80a  src/driver/chatgpt.ts' | sha256sum -c - \
 && echo 'f7872f5d41d520e45125715a56172b93bdc1386d73767f1cdabfe2915bcd02d6  src/main.ts' | sha256sum -c - \
 && echo '269c7039c26dba2a8d325353aa8075fb280cf68a0c6aa90502c207e045be1ee0  src/bridge/loop.ts' | sha256sum -c - \
 && patch --batch --fuzz=0 -p1 < /tmp/read-page.patch \
 && patch --batch --fuzz=0 -p1 < /tmp/shutdown.patch \
 && patch --batch --fuzz=0 -p1 < /tmp/router-step.patch \
 && rm /tmp/read-page.patch /tmp/shutdown.patch /tmp/router-step.patch \
 && npm ci --ignore-scripts --omit=dev --no-audit --no-fund
COPY deploy/bridge/runtime/ /app/deployment/
COPY deploy/bridge/supervise.py deploy/bridge/health.py deploy/bridge/bridge deploy/bridge/router /opt/bridge/
RUN chmod 755 /opt/bridge/bridge /opt/bridge/router \
 && mkdir -p /home/node/profile /data/spool /data/control \
 && chown -R node:node /home/node/profile /data
ENV DISPLAY=:0 PYTHONPATH=/opt/websockify BRIDGE_SPOOL=/data/spool \
    BRIDGE_CDP_URL=http://127.0.0.1:9222
USER node
CMD ["python3", "/opt/bridge/supervise.py"]
