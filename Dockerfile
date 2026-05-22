# Use a slim Node.js LTS image
FROM node:20-slim

# Install dependencies required by better-sqlite3 compilation
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package dependency manifests
COPY package*.json ./

# Install only production dependencies (better-sqlite3 will compile automatically)
RUN npm install --production

# Copy the rest of the application files
COPY . .

# Pre-create the database directory
RUN mkdir -p data

# Expose port (Render overrides this via PORT env variable)
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
