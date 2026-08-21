FROM oven/bun:1.3.6-alpine@sha256:819f91180e721ba09e0e5d3eb7fb985832fd23f516e18ddad7e55aaba8100be7
WORKDIR /app
COPY package.json bun.lock* bunfig.toml tsconfig.base.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY model-workers ./model-workers
RUN bun install --frozen-lockfile
COPY model-workers/reference/fixtures /app/fixtures
RUN mkdir -p /work && chown bun:bun /work
ENV NODE_ENV=development
USER bun
CMD ["bun", "run", "model-workers/reference/src/server.ts"]
