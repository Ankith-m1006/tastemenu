FROM node:22-slim
WORKDIR /app
# Qloo's official harness provides `qloo mcp`, which the backend starts as a child process.
RUN npm install --global @qloo/qloo-harness@0.1.26 && npm cache clean --force
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
ENV NODE_ENV=production \
    PORT=8080 \
    QLOO_BASE_URL=https://hackathon.api.qloo.com \
    QLOO_TRUSTED_BASE_URL=https://hackathon.api.qloo.com
EXPOSE 8080
CMD ["node", "src/server.mjs"]
