FROM nginx:1.30.7-alpine@sha256:caf4e1e032a20f9c3c5e28fc7f25ffd768ad8677b4975c54193075997b3a97e3

COPY deploy/nginx /etc/nginx/qm

ARG PKG_REFRESH_RUN_ID=
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked apk upgrade --no-cache \
  && printf 'os packages refreshed for run %s\n' "${PKG_REFRESH_RUN_ID:-unknown}"

EXPOSE 8080

CMD ["nginx", "-c", "/etc/nginx/qm/nginx.conf", "-g", "daemon off;"]
