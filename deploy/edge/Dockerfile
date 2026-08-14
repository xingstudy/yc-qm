FROM nginx:1.30-alpine@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46

COPY deploy/nginx /etc/nginx/qm

EXPOSE 8080

CMD ["nginx", "-c", "/etc/nginx/qm/nginx.conf", "-g", "daemon off;"]
