FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN apk add --no-cache git && npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
