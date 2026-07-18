#define _GNU_SOURCE

#include <errno.h>
#include <netdb.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
#include <fcntl.h>

static void record_attempt(const char *operation) {
    const char *path = getenv("SATORI_NETWORK_GUARD_LOG");
    if (path == NULL || path[0] == '\0') {
        return;
    }
    int fd = open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
    if (fd < 0) {
        return;
    }
    ssize_t operation_write = write(fd, operation, strlen(operation));
    ssize_t newline_write = write(fd, "\n", 1);
    if (operation_write < 0 || newline_write < 0) {
        /* The guard must still deny networking if evidence logging fails. */
    }
    (void)close(fd);
}

int socket(int domain, int type, int protocol) {
    (void)domain;
    (void)type;
    (void)protocol;
    record_attempt("socket");
    errno = EPERM;
    return -1;
}

int socketpair(int domain, int type, int protocol, int sv[2]) {
    (void)domain;
    (void)type;
    (void)protocol;
    (void)sv;
    record_attempt("socketpair");
    errno = EPERM;
    return -1;
}

int connect(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
    (void)sockfd;
    (void)addr;
    (void)addrlen;
    record_attempt("connect");
    errno = EPERM;
    return -1;
}

ssize_t sendto(int sockfd, const void *buf, size_t len, int flags,
               const struct sockaddr *dest_addr, socklen_t addrlen) {
    (void)sockfd;
    (void)buf;
    (void)len;
    (void)flags;
    (void)dest_addr;
    (void)addrlen;
    record_attempt("sendto");
    errno = EPERM;
    return -1;
}

ssize_t sendmsg(int sockfd, const struct msghdr *msg, int flags) {
    (void)sockfd;
    (void)msg;
    (void)flags;
    record_attempt("sendmsg");
    errno = EPERM;
    return -1;
}

int getaddrinfo(const char *node, const char *service,
                const struct addrinfo *hints, struct addrinfo **res) {
    (void)node;
    (void)service;
    (void)hints;
    (void)res;
    record_attempt("getaddrinfo");
    return EAI_SYSTEM;
}
