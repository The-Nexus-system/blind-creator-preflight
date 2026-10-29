FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY client ./client
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server/index.js"]
