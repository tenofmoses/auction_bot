FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
COPY prisma.config.ts ./
COPY tsconfig.json ./
COPY src ./src

CMD ["sh", "-c", "npx prisma generate && npx prisma migrate deploy && npm start"]
