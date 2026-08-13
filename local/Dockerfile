ARG BASE=qm-sandbox-base:dev
FROM ${BASE}

ARG SANDBOX_FINGERPRINT
COPY aws/microvm-agent/agent.mjs /opt/microvm-agent/agent.mjs

LABEL qm.sandbox-fingerprint=${SANDBOX_FINGERPRINT}
ENV HOME=/root
WORKDIR /root
EXPOSE 8080
CMD ["node", "/opt/microvm-agent/agent.mjs"]
