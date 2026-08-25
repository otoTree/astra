FROM oven/bun:1.3.6@sha256:f20d9cf365ab35529384f1717687c739c92e6f39157a35a95ef06f4049a10e4a AS build

WORKDIR /workspace
COPY package.json bun.lock* tsconfig.base.json tsconfig.json bunfig.toml ./
COPY patches ./patches
COPY apps ./apps
COPY packages ./packages
COPY model-workers ./model-workers
COPY scripts ./scripts
RUN bun install --frozen-lockfile
RUN bun run --cwd apps/admin-web build

FROM oven/bun:1.3.6@sha256:f20d9cf365ab35529384f1717687c739c92e6f39157a35a95ef06f4049a10e4a AS runtime

WORKDIR /app
COPY apps/admin-web/server.ts ./server.ts
COPY --from=build /workspace/apps/admin-web/dist ./dist

EXPOSE 8080
ENV ADMIN_WEB_PORT=8080
USER bun
CMD ["bun", "run", "/app/server.ts"]
