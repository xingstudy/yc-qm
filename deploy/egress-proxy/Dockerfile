FROM envoyproxy/envoy:distroless-v1.39.0@sha256:7877ad87afd7459e1bd2a077ff601fec7c93aeecd62e71664560d96328c62cf4 AS envoy
COPY deploy/egress-proxy/envoy.yaml /tmp/envoy.yaml
RUN ["/usr/local/bin/envoy", "--mode", "validate", "-c", "/tmp/envoy.yaml"]

FROM node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS node-base

FROM node-base AS dependencies
WORKDIR /app
ARG NPM_INSTALL_REGISTRY=https://registry.npmjs.org
COPY package.json package-lock.json ./
COPY .husky/install.mjs .husky/install.mjs
RUN --mount=type=cache,target=/root/.npm,sharing=shared npm ci --omit=dev --prefer-offline --no-audit --registry="${NPM_INSTALL_REGISTRY}"

FROM node-base AS firewall
ARG PKG_REFRESH_RUN_ID=
RUN apt-get update -o APT::Update::Error-Mode=any \
  && apt-get install -y --no-install-recommends coreutils dash iptables libmnl0 libnftnl11 libxtables12 libstdc++6 libgcc-s1 \
  && lib_dir=$(dirname "$(find /usr/lib -name libxtables.so.12 -print -quit)") \
  && runtime_lib="/runtime${lib_dir}" \
  && mkdir -p /runtime/usr/bin "$runtime_lib/xtables" /runtime/var/lib/dpkg/status.d \
  && cp /bin/dash /runtime/usr/bin/dash \
  && cp /bin/sleep /runtime/usr/bin/sleep \
  && ln -s dash /runtime/usr/bin/sh \
  && cp /usr/sbin/xtables-nft-multi /runtime/usr/bin/xtables-nft-multi \
  && ln -s xtables-nft-multi /runtime/usr/bin/iptables \
  && ln -s xtables-nft-multi /runtime/usr/bin/ip6tables \
  && cp -a "$lib_dir"/libxtables.so.12* "$lib_dir"/libmnl.so.0* "$lib_dir"/libnftnl.so.11* "$lib_dir"/libstdc++.so.6* "$lib_dir"/libgcc_s.so.1 "$runtime_lib/" \
  && cp "$lib_dir/xtables/libipt_REJECT.so" "$lib_dir/xtables/libip6t_REJECT.so" "$lib_dir/xtables/libxt_conntrack.so" "$lib_dir/xtables/libxt_tcp.so" "$lib_dir/xtables/libxt_standard.so" "$runtime_lib/xtables/" \
  && for package in coreutils dash iptables libmnl0 libnftnl11 libxtables12 libstdc++6 libgcc-s1; do \
       dpkg-query -s "$package" > "/runtime/var/lib/dpkg/status.d/$package"; \
     done \
  && printf 'os packages refreshed for run %s\n' "${PKG_REFRESH_RUN_ID:-unknown}"

FROM gcr.io/distroless/base-nossl-debian13:latest@sha256:f21fdfe4ede467d9ea8a6caaec1f8381ea4502243a3e8bb1c43df80c6fbaaeae

COPY --from=node-base /usr/local/bin/node /nodejs/bin/node
COPY --from=node-base /usr/local/LICENSE /usr/share/licenses/nodejs/LICENSE
COPY --from=envoy /usr/local/bin/envoy /usr/local/bin/envoy
COPY --from=firewall /runtime/usr/ /usr/
COPY --from=firewall /runtime/var/lib/dpkg/status.d/ /var/lib/dpkg/status.d/

WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY licenses/earendil-works-pi-coding-agent.LICENSE /usr/share/licenses/qm/pi-coding-agent.LICENSE
COPY src ./src
COPY plugins/chassis/src ./plugins/chassis/src
COPY tsconfig.json ./
COPY --chmod=755 deploy/egress-proxy/envoy.yaml deploy/egress-proxy/start.sh ./
ENV NODE_ENV=production
ENV PATH="/nodejs/bin:/usr/local/bin:/usr/bin:/bin"
RUN node -e "if (process.config.variables.node_shared_openssl || !process.versions.openssl) process.exit(1)" \
  && envoy --mode validate -c /app/envoy.yaml \
  && iptables --version \
  && ip6tables --version \
  && sleep 0

EXPOSE 48080

ENTRYPOINT ["/bin/sh", "/app/start.sh"]
