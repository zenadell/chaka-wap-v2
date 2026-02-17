# We use the FULL node image (not slim) so Git is pre-installed
FROM node:20-bullseye-slim

# Install system dependencies (Git is required for some npm packages)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Set up app
WORKDIR /app

# Copy dependency file
COPY package.json ./

# Install dependencies (This will work now because Git is included)
RUN npm install

# Copy the rest of your code
COPY . .

# Fix permissions
RUN chmod -R 777 /app

# Open Port
EXPOSE 7860

# Start
CMD [ "node", "index.js" ]
