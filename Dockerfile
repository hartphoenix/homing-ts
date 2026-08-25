FROM oven/bun:1.3.9-alpine@sha256:9028ee7a60a04777190f0c3129ce49c73384d3fc918f3e5c75f5af188e431981 AS build

WORKDIR /opt/app
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3.9-alpine@sha256:9028ee7a60a04777190f0c3129ce49c73384d3fc918f3e5c75f5af188e431981 AS runtime

ENV NODE_ENV=production
ENV HOMING_DEMO_ACCOUNTS=0
WORKDIR /opt/app
RUN addgroup -g 10001 -S app && adduser -u 10001 -S app -G app
COPY --chown=app:app package.json bun.lock ./
COPY --chown=app:app patches ./patches
RUN bun install --frozen-lockfile --production
COPY --from=build --chown=app:app /opt/app/dist ./dist
COPY --chown=app:app agentkit ./agentkit
COPY --chown=app:app drizzle ./drizzle
COPY --chown=app:app src/server ./src/server
USER app
EXPOSE 8000
ENTRYPOINT []
CMD ["bun", "src/server/index.ts"]
