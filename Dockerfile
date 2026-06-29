FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN apk add --no-cache git openssh docker-cli docker-cli-compose && npm ci --omit=dev
RUN ssh-keyscan github.com >> /etc/ssh/ssh_known_hosts 2>/dev/null
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
