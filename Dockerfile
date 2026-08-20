FROM oven/bun:1.3.9-alpine AS build

WORKDIR /opt/app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3.9-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /opt/app
RUN addgroup -g 10001 -S app && adduser -u 10001 -S app -G app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build --chown=app:app /opt/app/dist ./dist
COPY --chown=app:app agentkit ./agentkit
COPY --chown=app:app drizzle ./drizzle
COPY --chown=app:app src/server ./src/server
USER app
EXPOSE 8000
ENTRYPOINT []
CMD ["bun", "src/server/index.ts"]
