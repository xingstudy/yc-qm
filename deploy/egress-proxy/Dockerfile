FROM envoyproxy/envoy:distroless-v1.39.0@sha256:7877ad87afd7459e1bd2a077ff601fec7c93aeecd62e71664560d96328c62cf4 AS envoy
COPY deploy/egress-proxy/envoy.yaml /tmp/envoy.yaml
RUN ["/usr/local/bin/envoy", "--mode", "validate", "-c", "/tmp/envoy.yaml"]

FROM node:24-trixie-slim@sha256:0711b541c1c33a8a530ac4f0d391baa9a15b3d804695b1b24a47daa5fb60e74d AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-trixie-slim@sha256:0711b541c1c33a8a530ac4f0d391baa9a15b3d804695b1b24a47daa5fb60e74d AS firewall
RUN apt-get update \
  && apt-get install -y --no-install-recommends iptables \
  && lib_dir=$(dirname "$(find /usr/lib -name libxtables.so.12 -print -quit)") \
  && runtime_lib="/runtime${lib_dir}" \
  && mkdir -p /runtime/usr/bin "$runtime_lib/xtables" /runtime/var/lib/dpkg/status.d \
  && cp /bin/dash /runtime/usr/bin/dash \
  && cp /bin/sleep /runtime/usr/bin/sleep \
  && ln -s dash /runtime/usr/bin/sh \
  && cp /usr/sbin/xtables-nft-multi /runtime/usr/bin/xtables-nft-multi \
  && ln -s xtables-nft-multi /runtime/usr/bin/iptables \
  && ln -s xtables-nft-multi /runtime/usr/bin/ip6tables \
  && cp -a "$lib_dir"/libxtables.so.12* "$lib_dir"/libmnl.so.0* "$lib_dir"/libnftnl.so.11* "$runtime_lib/" \
  && cp "$lib_dir/xtables/libipt_REJECT.so" "$lib_dir/xtables/libip6t_REJECT.so" "$runtime_lib/xtables/" \
  && for package in coreutils dash iptables libmnl0 libnftnl11 libxtables12; do \
       dpkg-query -s "$package" > "/runtime/var/lib/dpkg/status.d/$package"; \
     done

FROM gcr.io/distroless/nodejs24-debian13:latest@sha256:2e3b3a96d1d7286c3e4727f9c84b4dc32b6b33e7d7d4425c5a5c8186ad85fa93

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
RUN envoy --mode validate -c /app/envoy.yaml

ENV NODE_ENV=production
ENV PATH="/nodejs/bin:/usr/local/bin:/usr/bin:/bin"
EXPOSE 48080

ENTRYPOINT ["/bin/sh", "/app/start.sh"]
