FROM node:18-alpine

WORKDIR /app

# Install dependencies (only)
COPY package.json package-lock.json ./
RUN npm install

# Copy source
COPY . .

# Create data directory
RUN mkdir -p data/downloads data/logs

# Expose Web UI port
EXPOSE 3000

# Default command (Web UI + Monitor)
# Users can override this to run 'monitor' only if needed
CMD ["npm", "run", "web"]
