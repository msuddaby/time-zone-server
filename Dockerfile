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

CMD [ "npm", "start" ]
