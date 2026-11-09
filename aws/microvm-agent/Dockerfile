FROM golang:1.26.10-alpine@sha256:27f2d3b83cfc5803c8078f8e730af0f7c431bf067afaec8f60a36fb763187cba AS gh-builder
ENV GOTOOLCHAIN=local

ARG GH_VERSION=2.99.0
ARG X_MOD_VERSION=0.41.0
RUN go mod download "github.com/cli/cli/v2@v${GH_VERSION}" \
  && mkdir /tmp/gh \
  && cp -a "/go/pkg/mod/github.com/cli/cli/v2@v${GH_VERSION}/." /tmp/gh \
  && cd /tmp/gh \
  && go get "golang.org/x/mod@v${X_MOD_VERSION}" golang.org/x/net@v0.62.0 \
  && GH_VERSION="$GH_VERSION" SOURCE_DATE_EPOCH=1785456000 go run script/build.go bin/gh \
  && install bin/gh /usr/local/bin/gh \
  && go version -m /usr/local/bin/gh | grep -Eq "golang.org/x/mod[[:space:]]+v${X_MOD_VERSION}([[:space:]]|$)"

FROM golang:1.26.10-alpine@sha256:27f2d3b83cfc5803c8078f8e730af0f7c431bf067afaec8f60a36fb763187cba AS litestream-build
ENV GOTOOLCHAIN=local

RUN apk upgrade --no-cache && apk add --no-cache build-base
RUN go mod download github.com/benbjohnson/litestream@v0.3.14 \
  && mkdir /litestream \
  && cp -a /go/pkg/mod/github.com/benbjohnson/litestream@v0.3.14/. /litestream/ \
  && chmod -R u+w /litestream
COPY litestream.go.mod /litestream/go.mod
COPY litestream.go.sum /litestream/go.sum
RUN cd /litestream \
  && go mod download \
  && CGO_ENABLED=1 go build -mod=readonly -tags osusergo,netgo,sqlite_omit_load_extension \
      -ldflags '-linkmode external -extldflags -static -X main.Version=0.3.14-qm.1' \
      -o /out/litestream ./cmd/litestream

FROM public.ecr.aws/lambda/microvms:al2023-minimal@sha256:3e45d46e969eb0d34ea954aff12747e15ca3f4a594788812c7218445777fa4bc

ARG PKG_REFRESH_RUN_ID=
RUN dnf upgrade -y --releasever=latest \
  && dnf install -y --releasever=latest \
      curl-minimal findutils tar git wget jq unzip \
      python3.12 python3.12-pip nodejs24 nodejs24-npm \
  && dnf clean all \
  && rpm -q openssl-snapsafe-libs \
  && curl --version \
  && node --version \
  && npm --version \
  && npx --version \
  && setsid --version \
  && seq 1 1

COPY --from=gh-builder /usr/local/bin/gh /usr/local/bin/gh
COPY --from=litestream-build /out/litestream /usr/local/bin/litestream
COPY --from=litestream-build /litestream/LICENSE /usr/share/licenses/litestream/LICENSE
COPY patch-npm.sh /tmp/patch-npm.sh
RUN sh /tmp/patch-npm.sh && rm /tmp/patch-npm.sh

RUN gh --version

COPY awscli-constraints.txt /tmp/awscli-constraints.txt
RUN curl -fsSL "https://codeload.github.com/aws/aws-cli/tar.gz/refs/tags/2.39.6" -o /tmp/awscli.tgz \
  && echo "d4cfa933d7ed916f9eca693ee9e863c0560021bd61bcf9f04963c56870313b4f  /tmp/awscli.tgz" | sha256sum -c - \
  && mkdir /tmp/awscli \
  && tar -xzf /tmp/awscli.tgz -C /tmp/awscli --strip-components=1 \
  && grep -F 'urllib3>=1.25.4,<=2.6.3' /tmp/awscli/pyproject.toml \
  && sed -i 's/urllib3>=1.25.4,<=2.6.3/urllib3==2.8.0/' /tmp/awscli/pyproject.toml \
  && python3.12 -m venv /opt/awscli \
  && /opt/awscli/bin/pip install --no-cache-dir --upgrade pip==26.2.2 \
  && /opt/awscli/bin/pip install --no-cache-dir -c /tmp/awscli-constraints.txt /tmp/awscli \
  && /opt/awscli/bin/pip check \
  && /opt/awscli/bin/python -c 'import urllib3; assert urllib3.__version__ == "2.8.0"' \
  && /opt/awscli/bin/pip uninstall -y setuptools pip \
  && ln -s /opt/awscli/bin/aws /usr/local/bin/aws \
  && ln -s /opt/awscli/bin/aws_completer /usr/local/bin/aws_completer \
  && rm -rf /tmp/awscli /tmp/awscli.tgz /tmp/awscli-constraints.txt \
  && aws --version

RUN litestream version

RUN python3.12 -m venv /opt/agent-venv \
  && /opt/agent-venv/bin/pip install --no-cache-dir --upgrade pip==26.2.2
COPY patch-pip-vendor.sh /tmp/patch-pip-vendor.sh
RUN sh /tmp/patch-pip-vendor.sh && rm /tmp/patch-pip-vendor.sh
ENV PATH="/opt/agent-venv/bin:${PATH}"
ENV VIRTUAL_ENV=/opt/agent-venv

COPY agent.mjs /opt/microvm-agent/agent.mjs

ENV HOME=/root
WORKDIR /root

CMD ["node", "/opt/microvm-agent/agent.mjs"]
