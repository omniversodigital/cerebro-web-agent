# Use the official Playwright Python image which has all browser dependencies pre-installed
FROM mcr.microsoft.com/playwright/python:v1.49.0-jammy

# Install Node.js and NPM
RUN apt-get update && apt-get install -y curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy and install Node.js dependencies
COPY package.json package-lock.json* ./
RUN npm install

# Copy and install Python dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy source files
COPY . .

# Expose server port
EXPOSE 3000

# Start Express application
CMD ["npm", "start"]
