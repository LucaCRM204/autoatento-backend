# AutoAtento backend — imagen para Railway (railway.json la usa)
# Node 22 LTS (Node 18 ya no tiene soporte de seguridad).
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# multer guarda temporales en uploads/temp y el proceso corre como "node"
RUN mkdir -p uploads/temp && chown -R node:node uploads
EXPOSE 3001
USER node
CMD ["npm", "start"]
