# syntax=docker/dockerfile:1
FROM python:3.12-slim
ARG SERVICE=mcp
WORKDIR /app
COPY src/mcp/requirements.lock.txt ./requirements.lock.txt
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export PIP_CERT=/run/secrets/proxy_ca; fi; \
    pip install --no-cache-dir -r requirements.lock.txt
COPY --chown=10001:10001 src/mcp/${SERVICE}/ ./
RUN python -m compileall -q . && useradd -r -u 10001 mcp && mkdir -p /app/data/oauth && chown -R mcp:mcp /app/data
USER mcp
ENV PYTHONUNBUFFERED=1 HOME=/app/data MCP_HOST=0.0.0.0 MCP_PORT=8000 UNIPILE_MCP_HOST=0.0.0.0 UNIPILE_MCP_PORT=8000
EXPOSE 8000
CMD ["python", "server.py"]
