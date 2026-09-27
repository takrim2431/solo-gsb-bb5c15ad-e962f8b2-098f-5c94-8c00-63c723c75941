FROM node:20-alpine

WORKDIR /app

# 仅安装生产依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 应用代码
COPY server.js ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
