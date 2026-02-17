FROM node:18-bullseye-slim

# 1. Install Git and Build Tools (CRITICAL FIX)
# We add python3, make, and g++ in case any packages need to compile native code
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# 2. Set working directory
WORKDIR /app

# 3. Copy package files first (better caching)
COPY package.json ./

# 4. Install dependencies (Now Git is available!)
RUN npm install

# 5. Copy the rest of the application
COPY . .

# 6. Fix permissions for storage folders
RUN mkdir -p /app/auth_info && chmod -R 777 /app/auth_info

# 7. Open the correct port
EXPOSE 7860

# 8. Start the bot
CMD [ "node", "index.js" ]
