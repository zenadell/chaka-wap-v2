FROM node:20-bullseye-slim

# Install system dependencies (Git is required for some npm packages)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Create App Directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source
COPY . .

# Permissions (Fixes many permission errors)
RUN chmod -R 777 /app

# Expose Port
EXPOSE 7860

# Start
CMD [ "node", "index.js" ]
