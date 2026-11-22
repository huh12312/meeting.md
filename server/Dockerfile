FROM node:24-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
# Claude Code CLI for LLM_PROVIDER=claude-code, installed unmodified from npm.
# It is Anthropic's software under Anthropic's Commercial Terms, not part of
# meeting.md's license (see NOTICE). Build with --build-arg INSTALL_CLAUDE_CODE=0
# for an image without it.
ARG INSTALL_CLAUDE_CODE=1
RUN if [ "$INSTALL_CLAUDE_CODE" = "1" ]; then npm install -g @anthropic-ai/claude-code && npm cache clean --force; fi
LABEL org.opencontainers.image.title="meeting.md" \
      org.opencontainers.image.description="Self-hosted meeting recording, live transcription and AI notes: API server" \
      org.opencontainers.image.licenses="MIT"
ENV DATA_DIR=/data PORT=8080
RUN mkdir /data && chown node:node /data
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "src/index.js"]
