# A static binary in an empty image: nothing but the server, running as an unprivileged user.
FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
# dependencies first, so a code change does not rebuild them
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src
COPY src ./src
RUN touch src/main.rs && cargo build --release
# the data folder belongs to the server user; a new named volume takes this owner over
RUN mkdir -p /data && chown 65534:65534 /data

FROM scratch
COPY --from=build /src/target/release/sync-server /sync-server
COPY --from=build --chown=65534:65534 /data /data
USER 65534:65534
ENV SYNC_DATA=/data SYNC_PORT=8080
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD ["/sync-server", "healthcheck"]
ENTRYPOINT ["/sync-server"]
