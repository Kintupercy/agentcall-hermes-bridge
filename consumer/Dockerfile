# The consumer is standard-library Python on purpose, so the image is the
# base plus one file. curl is here for the healthcheck and for brains that
# shell out to an HTTP agent.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates jq \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY agentcall_sms_consumer.py /app/
COPY brains/ /app/brains/

RUN chmod +x /app/brains/*.sh 2>/dev/null || true

# State (counters + the replied-message set) must outlive the container, or a
# restart mid-flight can re-answer a text that was already answered. Mount a
# volume here — docker-compose.yml does.
# The consumer binds health to loopback by default. Inside a container the
# network namespace is the boundary, so bind all interfaces here — that is what
# lets `docker compose` publish or probe the port.
ENV AGENTCALL_STATE_DIR=/var/lib/agentcall-sms-consumer \
    AGENTCALL_HEALTH_PORT=8787 \
    AGENTCALL_HEALTH_HOST=0.0.0.0 \
    PYTHONUNBUFFERED=1
RUN mkdir -p /var/lib/agentcall-sms-consumer

# A consumer that is running but not polling is the dangerous state: texts
# queue on the bridge and nothing looks wrong. /healthz goes 503 once polls go
# stale, and the restart policy takes it from there.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/healthz || exit 1

EXPOSE 8787

ENTRYPOINT ["python3", "/app/agentcall_sms_consumer.py"]
CMD ["run"]
