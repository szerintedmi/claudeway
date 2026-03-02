FROM oven/bun:1-slim AS base

# Install git (for Claude's git read access) and Node.js (for Claude CLI)
RUN apt-get update && apt-get install -y git nodejs npm && rm -rf /var/lib/apt/lists/*

# Install Claude CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user
RUN useradd -m -s /bin/bash claudeway

# Set working directory
WORKDIR /app

# Copy dependency files first (for layer caching)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

# Copy source code
COPY src/ ./src/
COPY tsconfig.json ./
COPY CLAUDE.md ./
COPY .claude/ ./.claude/
COPY docs/ ./docs/
COPY config.example.yaml ./

# Configure git to use credential store (PAT-based, file mounted at runtime)
RUN git config --system credential.helper 'store --file=/home/claudeway/.git-credentials'

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Create runtime directories
RUN mkdir -p .queue .files .claudeway-tmp .repos && \
    chown -R claudeway:claudeway /app

# Create Claude CLI debug directory — the CLI writes error logs here and crashes
# silently if it's missing, masking the real error
RUN mkdir -p /home/claudeway/.claude/debug && \
    chown -R claudeway:claudeway /home/claudeway/.claude

# Create SSH directory and config for git SSH access
RUN mkdir -p /home/claudeway/.ssh && \
    printf "Host github.com\n  IdentityFile /home/claudeway/.ssh/id_ed25519\n  IdentitiesOnly yes\n  StrictHostKeyChecking accept-new\n" > /home/claudeway/.ssh/config && \
    chown -R claudeway:claudeway /home/claudeway/.ssh && \
    chmod 700 /home/claudeway/.ssh && \
    chmod 600 /home/claudeway/.ssh/config

USER claudeway

# Set git user (can be overridden by mounting .gitconfig)
RUN git config --global user.name "Claudeway Bot" && \
    git config --global user.email "claudeway@localhost"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "src/index.ts"]
