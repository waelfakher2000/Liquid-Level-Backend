# Build a small container for the API bridge
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Install deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY src ./src

# Expose port
EXPOSE 8080

# Start
CMD ["node", "src/index.js"]
