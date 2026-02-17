FROM node:18-bullseye-slim

# 1. Set working directory
WORKDIR /app

# 2. Copy package files and install dependencies
COPY package.json ./
RUN npm install

# 3. Copy the rest of the application
COPY . .

# 4. Fix permissions for storage folders
RUN mkdir -p /app/auth_info && chmod -R 777 /app/auth_info

# 5. Open the correct port
EXPOSE 7860

# 6. Start the bot
CMD [ "node", "index.js" ]
