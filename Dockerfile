FROM node:24-slim
WORKDIR /app
COPY --chown=node:node . .
RUN apt-get update && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/data && chown node:node /app/data \
    && chmod +x /app/docker-entrypoint.sh
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4175 DATABASE_PATH=/app/data/nextstep.sqlite
EXPOSE 4175
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
