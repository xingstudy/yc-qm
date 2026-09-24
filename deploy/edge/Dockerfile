FROM nginx:1.30-alpine@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46

COPY deploy/nginx /etc/nginx/qm

ARG PKG_REFRESH_RUN_ID=
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked apk upgrade --no-cache \
  && printf 'os packages refreshed for run %s\n' "${PKG_REFRESH_RUN_ID:-unknown}"

EXPOSE 8080

CMD ["nginx", "-c", "/etc/nginx/qm/nginx.conf", "-g", "daemon off;"]
