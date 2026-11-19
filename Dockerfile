FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
ENV NODE_ENV=production PORT=4000 DB_FILE=/app/data/agent-rooms.db
VOLUME /app/data
EXPOSE 4000
CMD ["node", "--no-warnings=ExperimentalWarning", "--import", "tsx", "src/server.ts"]
