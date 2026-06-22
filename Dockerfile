# Образ для деплоя на любой Node-совместимый хостинг (Render, Railway, Fly, VPS).
FROM node:22-alpine

WORKDIR /app

# Сначала зависимости — лучше кешируется
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Затем код
COPY . .

# Порт берётся из переменной PORT (по умолчанию 3000)
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
