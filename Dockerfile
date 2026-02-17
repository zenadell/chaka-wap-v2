FROM node:20-bullseye-slim

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
