# Run Valet on any machine with Docker, whatever its glibc: the nearcore sandbox binary needs
# glibc 2.39 or newer, which Debian 13 (trixie) has.
#
#   docker build -t valet .
#   docker run --rm valet                          # the attack demo
#   docker run --rm valet npm run test:unit        # unit tests
#   docker run --rm valet npm run test:e2e         # end-to-end tests on the real chain (about 10 minutes)
#   docker run --rm -it -p 127.0.0.1:8787:8787 -e VALET_CONSOLE_HOST=0.0.0.0 -e VALET_CONSOLE_PORT=8787 valet npm run sandbox
#                                                  # the web console: open the link it prints
#                                                  # (publish the same port number on both sides)
FROM node:22-trixie

# The directory must belong to the unprivileged user: npm ci writes node_modules into it.
RUN mkdir /valet && chown node:node /valet
WORKDIR /valet
USER node

# Dependencies first, from the lockfile, so that editing a source file does not install them again.
COPY --chown=node:node package.json package-lock.json .npmrc ./
COPY --chown=node:node packages/oracle/package.json packages/oracle/
COPY --chown=node:node packages/client/package.json packages/client/
COPY --chown=node:node packages/mcp/package.json packages/mcp/
COPY --chown=node:node packages/e2e/package.json packages/e2e/
COPY --chown=node:node demo/package.json demo/
RUN npm ci

COPY --chown=node:node . .

# The sandbox binary is downloaded once, here, and its SHA-256 is checked, so `docker run` needs no network.
RUN node --import tsx -e "import('./packages/e2e/src/sandbox.ts').then((m) => m.ensureSandboxBinary()).then((dir) => console.log('near-sandbox in', dir))"

ENV NO_COLOR=1
CMD ["npm", "run", "demo"]
