# Start from a Node.js base image
FROM node:22-slim

# Install system dependencies for Puppeteer
RUN apt-get update && apt-get install -y \
  libnss3 \
  libnspr4 \
  libfontconfig1 \
  libxkbcommon0 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libpango-1.0-0 \
  libpangocairo-1.0-0 \
  libcairo2 \
  libasound2 \
  libgdk-pixbuf2.0-0 \
  libgtk-3-0 \
  libxshmfence-dev \
  libxkbfile1 \
  libxcomposite1 \
  libxrandr2 \
  libgbm1 \
  libexpat1 \
  libdrm2

# Set the working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install application dependencies
RUN npm install

# Copy the rest of the application source
COPY . .

# Expose the port your app runs on
EXPOSE 10000

# Set the build command
CMD ["npm", "start"]