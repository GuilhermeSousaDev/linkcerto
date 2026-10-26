# A agenda (src/agendador.ts): manda ofertas pro grupo nos horários do .env.
# Sobe junto com o banco pelo docker-compose.yml — veja "Envio automático" no README.
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force

COPY tsconfig.json capas.json ./
COPY src ./src

# Mesmo uid do seu usuário no WSL: o que a agenda grava em data/ continua seu.
USER node

CMD ["node", "--import", "tsx", "src/agendador.ts"]
