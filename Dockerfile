FROM node:22-alpine

ENV NODE_ENV=production

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./

# npm ci installs exactly what package-lock.json pins, unlike npm install
RUN npm ci --omit=dev

# Bundle app source
COPY . .

# Drop from root to the unprivileged user the base image provides
USER node

EXPOSE 3000

# Exec node directly rather than via npm, so node is the process that receives
# SIGTERM. With "npm start" as PID 1 the signal is swallowed and the container
# exits 1 on a normal stop, which looks like a crash to restart policies.
CMD [ "node", "time-zone-service.js" ]
