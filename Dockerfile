FROM node:20-alpine
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install
ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/index.js"]
