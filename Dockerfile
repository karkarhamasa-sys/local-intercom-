# Multi-stage Docker build for the Free Intercome Go server

# Builder stage
FROM golang:1.26.1-alpine AS builder

WORKDIR /workspace

# Install git if needed for module download
RUN apk add --no-cache git

# Copy dependency files first for caching
COPY go.mod go.sum ./
RUN go mod download

# Copy the rest of the project and build the server binary
COPY . ./

ENV CGO_ENABLED=0
RUN go build -o /intercom ./main.go

# Final stage: minimal runtime image
FROM scratch

COPY --from=builder /intercom /intercom

EXPOSE 8443

ENTRYPOINT ["/intercom"]
