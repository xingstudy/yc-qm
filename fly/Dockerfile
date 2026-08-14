FROM golang:1.26.6-alpine@sha256:af8d6740070b8906d12eae1c3e3ea0957fb63f492051ea05e354c38ef9fe88df AS gh-builder

ARG GH_VERSION=2.97.0
RUN go mod download "github.com/cli/cli/v2@v${GH_VERSION}" \
  && cd "/go/pkg/mod/github.com/cli/cli/v2@v${GH_VERSION}" \
  && GH_VERSION="$GH_VERSION" SOURCE_DATE_EPOCH=1785456000 go run script/build.go bin/gh \
  && install bin/gh /usr/local/bin/gh

FROM node:24-trixie-slim@sha256:0711b541c1c33a8a530ac4f0d391baa9a15b3d804695b1b24a47daa5fb60e74d AS node-runtime

RUN npm install -g --allow-scripts=@anthropic-ai/claude-code \
      @anthropic-ai/claude-code@2.1.232 \
      @openai/codex@0.147.0 \
      npm@12.0.2 \
  && npm install --prefix /tmp/npm-fixes --ignore-scripts --omit=dev \
      brace-expansion@5.0.9 \
      ip-address@10.3.1 \
  && rm -rf \
      /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
      /usr/local/lib/node_modules/npm/node_modules/ip-address \
  && cp -a \
      /tmp/npm-fixes/node_modules/brace-expansion \
      /tmp/npm-fixes/node_modules/ip-address \
      /usr/local/lib/node_modules/npm/node_modules/ \
  && rm -rf /root/.npm /tmp/npm-fixes /tmp/node-compile-cache

FROM ubuntu:26.04@sha256:678c6550cc43645e08669028bc177f50be4e7c5b8cca677067b1914d4afc7a03

ARG DEBIAN_FRONTEND=noninteractive
ARG APT_MIRROR=
ARG TARGETARCH
ARG INSTALL_BROWSER_ENGINE=0
ARG CHROME_VERSION=151.0.7922.137-1
ARG CHROME_SHA=e6dabf044cf9cd0279cfe86efa431682c18bfc06d06339ce055aaa87ae871727
ARG PIP_VERSION=26.2.1

RUN cp /etc/apt/sources.list.d/ubuntu.sources /tmp/ubuntu.sources \
  && if [ -n "$APT_MIRROR" ]; then \
       sed -i \
         -e "s|http://archive.ubuntu.com/ubuntu/|${APT_MIRROR}|" \
         -e "s|http://security.ubuntu.com/ubuntu/|${APT_MIRROR}|" \
         /etc/apt/sources.list.d/ubuntu.sources; \
     fi \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
      bash coreutils findutils grep sed gawk \
      git curl wget jq unzip \
      nftables \
      python3 python3-venv python3-pip \
      ca-certificates gnupg \
      awscli \
  && if [ "$INSTALL_BROWSER_ENGINE" = "1" ]; then \
       test "$TARGETARCH" = amd64; \
       curl -fsSL \
         "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}_amd64.deb" \
         -o /tmp/chrome.deb; \
       echo "$CHROME_SHA  /tmp/chrome.deb" | sha256sum -c -; \
       apt-get install -y --no-install-recommends \
         /tmp/chrome.deb \
         fontconfig \
         fonts-liberation \
         fonts-noto-color-emoji \
         fonts-noto-cjk \
         fonts-freefont-ttf; \
       ln -s google-chrome-stable /usr/bin/chromium; \
       rm -f \
         /tmp/chrome.deb \
         /etc/apt/sources.list.d/google-chrome.list \
         /etc/apt/trusted.gpg.d/google-chrome.gpg; \
     fi \
  && mv /tmp/ubuntu.sources /etc/apt/sources.list.d/ubuntu.sources \
  && rm -f /usr/bin/pebble \
  && rm -rf /var/lib/apt/lists/*

COPY --from=node-runtime /usr/local/ /usr/local/
COPY --from=gh-builder /usr/local/bin/gh /usr/local/bin/gh

RUN claude --version \
  && codex --version \
  && node --version \
  && npm --version \
  && aws --version \
  && gh --version

RUN python3 -m venv /opt/agent-venv \
  && /opt/agent-venv/bin/pip install --no-cache-dir --upgrade "pip==${PIP_VERSION}"
ENV PATH="/opt/agent-venv/bin:${PATH}"
ENV VIRTUAL_ENV=/opt/agent-venv

COPY fly/tools/x-api /usr/local/bin/x-api
RUN chmod +x /usr/local/bin/x-api

ARG BROWSER_USE_VERSION=0.13.7
ARG BROWSER_USE_SHA=02c27e154c4820b5e3e6606b30a666f11e203525fd051db4b9b515c35e2c2f0d
ARG BROWSER_HARNESS_VERSION=0.1.8
ARG BROWSER_HARNESS_SHA=4a88d08e9c933622d728f006c3f70d6b6de052b388519c3aec5a030127ef4ea0
RUN if [ "$INSTALL_BROWSER_ENGINE" = "1" ]; then \
      set -eux; \
      python3 -m venv /opt/browser-engine/venv; \
      /opt/browser-engine/venv/bin/pip install --no-cache-dir --upgrade "pip==${PIP_VERSION}"; \
      curl -fsSL "https://files.pythonhosted.org/packages/source/b/browser-use/browser_use-${BROWSER_USE_VERSION}.tar.gz" -o /tmp/browser-use.tgz; \
      echo "$BROWSER_USE_SHA  /tmp/browser-use.tgz" | sha256sum -c -; \
      tar xzf /tmp/browser-use.tgz -C /tmp; \
      curl -fsSL "https://files.pythonhosted.org/packages/source/b/browser-harness/browser_harness-${BROWSER_HARNESS_VERSION}.tar.gz" -o /tmp/browser-harness.tgz; \
      echo "$BROWSER_HARNESS_SHA  /tmp/browser-harness.tgz" | sha256sum -c -; \
      tar xzf /tmp/browser-harness.tgz -C /tmp; \
      sed -i \
        -e 's/version = "0.13.7"/version = "0.13.7+qm.1"/' \
        -e 's/aiohttp==3.13.4/aiohttp==3.14.3/' \
        -e 's/mcp==1.26.0/mcp==1.28.1/' \
        -e 's/pillow==12.2.0/pillow==12.3.0/' \
        -e 's/pypdf==6.10.2/pypdf==6.14.2/' \
        -e 's/browser-harness==0.1.8/browser-harness==0.1.8+qm.1/' \
        "/tmp/browser_use-${BROWSER_USE_VERSION}/pyproject.toml"; \
      sed -i \
        -e 's/version = "0.1.8"/version = "0.1.8+qm.1"/' \
        -e 's/pillow==12.2.0/pillow==12.3.0/' \
        "/tmp/browser_harness-${BROWSER_HARNESS_VERSION}/pyproject.toml"; \
      /opt/browser-engine/venv/bin/pip install --no-cache-dir \
        msgpack==1.2.1 \
        setuptools==78.1.1 \
        "/tmp/browser_harness-${BROWSER_HARNESS_VERSION}" \
        "/tmp/browser_use-${BROWSER_USE_VERSION}"; \
      /opt/browser-engine/venv/bin/pip check; \
      /opt/browser-engine/venv/bin/python -c "import browser_use; print('browser-use ok')"; \
      /opt/browser-engine/venv/bin/pip uninstall -y setuptools pip; \
      /opt/browser-engine/venv/bin/python -c "import browser_use, msgpack; print('browser runtime ok')"; \
      /usr/bin/chromium --version; \
      /usr/bin/chromium --headless --no-sandbox --disable-gpu --dump-dom 'data:text/html,<p>browser-ok</p>' | grep browser-ok; \
      rm -rf \
        /tmp/browser-use.tgz "/tmp/browser_use-${BROWSER_USE_VERSION}" \
        /tmp/browser-harness.tgz "/tmp/browser_harness-${BROWSER_HARNESS_VERSION}"; \
      mkdir -p /var/lib/dbus; \
      : > /etc/machine-id; \
      : > /var/lib/dbus/machine-id; \
    fi

RUN agent_site=$(/opt/agent-venv/bin/python -c 'import site; print(site.getsitepackages()[0])') \
  && grep -Fx 'msgpack==1.1.2' "$agent_site/pip/_vendor/vendor.txt" \
  && grep -Fx 'setuptools==70.3.0' "$agent_site/pip/_vendor/vendor.txt" \
  && jq -e \
      '([.components[] | select(.name == "msgpack" and .version == "1.1.2" and .purl == "pkg:pypi/msgpack@1.1.2")] | length) == 1 and ([.components[] | select(.name == "setuptools" and .version == "70.3.0" and .purl == "pkg:pypi/setuptools@70.3.0")] | length) == 1' \
      "$agent_site/pip/_vendor/bom.cdx.json" \
  && /opt/agent-venv/bin/pip install --no-cache-dir --no-deps --target /tmp/pip-vendor-fix \
      msgpack==1.2.1 \
      setuptools==78.1.1 \
  && sed -i \
      -e 's/^import packaging\./from pip._vendor import packaging\nfrom pip._vendor.packaging import /' \
      -e 's/^from jaraco\.text import /from pip._internal.utils._jaraco_text import /' \
      -e 's/^from platformdirs import /from pip._vendor.platformdirs import /' \
      /tmp/pip-vendor-fix/pkg_resources/__init__.py \
  && rm -rf "$agent_site/pip/_vendor/msgpack" "$agent_site/pip/_vendor/pkg_resources" \
  && cp -a \
      /tmp/pip-vendor-fix/msgpack \
      /tmp/pip-vendor-fix/pkg_resources \
      "$agent_site/pip/_vendor/" \
  && sed -i \
      -e 's/msgpack==1.1.2/msgpack==1.2.1/' \
      -e 's/setuptools==70.3.0/setuptools==78.1.1/' \
      "$agent_site/pip/_vendor/vendor.txt" \
  && jq \
      '.components |= map(if .name == "msgpack" then .["bom-ref"] = "pkg:pypi/msgpack@1.2.1" | .purl = "pkg:pypi/msgpack@1.2.1" | .version = "1.2.1" elif .name == "setuptools" then .["bom-ref"] = "pkg:pypi/setuptools@78.1.1" | .purl = "pkg:pypi/setuptools@78.1.1" | .version = "78.1.1" else . end) | .dependencies |= map(if .ref == "pkg:pypi/msgpack@1.1.2" then .ref = "pkg:pypi/msgpack@1.2.1" elif .ref == "pkg:pypi/setuptools@70.3.0" then .ref = "pkg:pypi/setuptools@78.1.1" else . end | if has("dependsOn") then .dependsOn |= map(if . == "pkg:pypi/msgpack@1.1.2" then "pkg:pypi/msgpack@1.2.1" elif . == "pkg:pypi/setuptools@70.3.0" then "pkg:pypi/setuptools@78.1.1" else . end) else . end)' \
      "$agent_site/pip/_vendor/bom.cdx.json" > "$agent_site/pip/_vendor/bom.cdx.json.tmp" \
  && mv "$agent_site/pip/_vendor/bom.cdx.json.tmp" "$agent_site/pip/_vendor/bom.cdx.json" \
  && rm -rf /tmp/pip-vendor-fix \
  && grep -Fx 'msgpack==1.2.1' "$agent_site/pip/_vendor/vendor.txt" \
  && grep -Fx 'setuptools==78.1.1' "$agent_site/pip/_vendor/vendor.txt" \
  && ! grep -Eq 'msgpack==1\.1\.2|setuptools==70\.3\.0' "$agent_site/pip/_vendor/vendor.txt" \
  && jq -e \
      '([.components[] | select(.name == "msgpack" and .version == "1.2.1" and .purl == "pkg:pypi/msgpack@1.2.1")] | length) == 1 and ([.components[] | select(.name == "setuptools" and .version == "78.1.1" and .purl == "pkg:pypi/setuptools@78.1.1")] | length) == 1 and ([.. | strings | select(. == "pkg:pypi/msgpack@1.1.2" or . == "pkg:pypi/setuptools@70.3.0")] | length) == 0' \
      "$agent_site/pip/_vendor/bom.cdx.json" \
  && /opt/agent-venv/bin/python -c 'from pip._vendor import msgpack, pkg_resources; assert msgpack.version == (1, 2, 1); assert str(pkg_resources.parse_version("1.2.3")) == "1.2.3"' \
  && /opt/agent-venv/bin/pip check \
  && /opt/agent-venv/bin/pip --version

ENV ANONYMIZED_TELEMETRY=false
ENV BROWSER_USE_CLOUD_SYNC=false

WORKDIR /workspace

CMD ["sh", "-c", "while true; do sleep 3600; done"]
