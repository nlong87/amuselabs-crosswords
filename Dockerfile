FROM node:20-slim

# Install Chrome's actual runtime dependencies, plus Chrome itself
RUN apt-get update && apt-get install -y \
    wget gnupg ca-certificates \
    fonts-liberation libnss3 libatk-bridge2.0-0 libgtk-3-0 \
    libxss1 libasound2 libxshmfence1 libgbm1 \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to skip its own Chromium download and use system Chrome instead
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]