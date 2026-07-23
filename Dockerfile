ARG SANDBOX_VERSION=0.12.1
ARG OPENCODE_VERSION=1.17.4

FROM docker.io/cloudflare/sandbox:${SANDBOX_VERSION}

ARG OPENCODE_VERSION
ENV PATH="/root/.opencode/bin:${PATH}" \
	XDG_STATE_HOME="/workspace/.opencode/state" \
	XDG_DATA_HOME="/workspace/.opencode/data" \
	XDG_CONFIG_HOME="/workspace/.opencode/config"

RUN curl -fsSL https://opencode.ai/install -o /tmp/install-opencode.sh \
	&& VERSION="${OPENCODE_VERSION}" bash /tmp/install-opencode.sh \
	&& rm /tmp/install-opencode.sh \
	&& opencode --version

COPY git-snapshot-stall /usr/local/bin/git
RUN chmod +x /usr/local/bin/git

WORKDIR /workspace
EXPOSE 4096
