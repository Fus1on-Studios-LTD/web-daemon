FROM node:18-alpine
WORKDIR /usr/src/panel-backend
COPY package.json ./
RUN npm install --production
COPY . .
EXPOSE 4000
CMD ["node","index.js"]
