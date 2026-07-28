# Big Hole as a container: no Node, no npm, no toolchain.
#
#   docker build -t big-hole .
#   docker run --rm -p 8080:80 big-hole
#   open http://localhost:8080
#
# Two stages, so what ships is the static build and a web server -- about 50 MB, none of it a
# build tool. The app has no backend and makes no network requests, so there is nothing else in
# here: no database, no API, no configuration.
#
# IMPORTANT, and the one thing that can bite: reach it on **localhost**. Browsers only grant
# OPFS and Web Workers to a "secure context", which means HTTPS or localhost. Opening this over
# a plain http://some-host address leaves the app unable to store a capture, and it fails during
# ingest -- which reads like a bug in the decoder rather than a deployment mistake. On a remote
# machine, tunnel it: `ssh -N -L 8080:127.0.0.1:8080 you@host` keeps the browser on localhost.

FROM node:20-alpine AS build
WORKDIR /src
# Dependencies first, against the lockfile, so editing source does not re-resolve the tree.
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /src/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
