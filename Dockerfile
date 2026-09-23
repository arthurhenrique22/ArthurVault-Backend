FROM ghcr.io/puppeteer/puppeteer:24.38.0

# Usar root temporariamente para copiar os arquivos e instalar dependências
USER root

WORKDIR /app

# Copiar os arquivos de pacote primeiro para aproveitar o cache do Docker
COPY package*.json ./

# Instalar as dependências do projeto
RUN npm ci

# Copiar o restante do código
COPY . .

# Mudar o proprietário dos arquivos para o usuário padrão do puppeteer (pptruser)
RUN chown -R pptruser:pptruser /app

# Voltar para o usuário sem privilégios para execução segura
USER pptruser

# A porta que o Express utiliza
EXPOSE 3001

# Comando de inicialização
CMD ["node", "server.js"]
