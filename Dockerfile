FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    OMO_HOST=0.0.0.0 \
    OMO_PORT=5189 \
    OMO_DATA_DIR=/data \
    OMO_WORKSPACE_ROOTS=/workspace \
    OMO_WEB_ROOT=/app/dist
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
RUN mkdir -p /data /workspace
EXPOSE 5189
CMD ["node", "server/index.cjs"]
