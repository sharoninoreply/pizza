FROM node:22-slim
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV DB_PATH=/data/pizzeria.db
EXPOSE 3000
CMD ["node", "server.js"]
