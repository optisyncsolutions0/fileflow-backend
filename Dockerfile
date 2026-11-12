# FileFlow backend: Node API + LibreOffice + Python PDF tools
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    NODE_ENV=production

# LibreOffice (Word/Excel/PowerPoint conversions), Python (PDF tools),
# 7-Zip (7z archives), Ghostscript (PDF compression) and fonts so documents render correctly
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
      python3 python3-pip \
      p7zip-full \
      fonts-dejavu-core fonts-liberation2 fonts-crosextra-carlito fonts-crosextra-caladea \
      fonts-noto-core fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .
RUN mkdir -p uploads

# Render sets PORT; 3001 is the local default
EXPOSE 3001
CMD ["node", "index.js"]
