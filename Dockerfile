FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
ENV FORCE_COLOR=1
ENTRYPOINT ["node", "/app/bin/sonar.js"]
CMD ["--help"]
