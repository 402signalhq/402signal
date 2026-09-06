"""Absolute socket read deadlines, checked for every underlying receive.

A buffered read/readline can issue many receives; a socket idle timeout alone
does not bound it. These wrappers retain buffering without resetting the budget.
"""
from __future__ import annotations

import http.client
import io
import urllib.request
from functools import partial

from live402 import clock


class _DeadlineRaw(io.RawIOBase):
    def __init__(self, sock, deadline=None):
        super().__init__()
        self.sock = sock
        self.source = sock.makefile('rb', buffering=0)
        self.idle_timeout = sock.gettimeout()
        self.deadline = deadline

    def readable(self):
        return True

    def readinto(self, buffer):
        timeout = self.idle_timeout
        if self.deadline is not None:
            left = self.deadline - clock.monotonic()
            if left <= 0:
                raise TimeoutError('absolute read timeout')
            timeout = left if timeout is None else min(timeout, left)
        self.sock.settimeout(timeout)
        size = self.source.readinto(buffer)
        if self.deadline is not None and clock.monotonic() >= self.deadline:
            raise TimeoutError('absolute read timeout')
        return size

    def close(self):
        try:
            self.source.close()
        finally:
            super().close()


class DeadlineReader(io.BufferedReader):
    def __init__(self, sock, deadline=None):
        super().__init__(_DeadlineRaw(sock, deadline))

    def set_deadline(self, deadline):
        self.raw.deadline = deadline
        if deadline is None:
            self.raw.sock.settimeout(self.raw.idle_timeout)


class _ResponseSocket:
    def __init__(self, sock, deadline):
        self.sock, self.deadline = sock, deadline

    def makefile(self, mode):
        if mode != 'rb':
            raise ValueError('read-only response socket required')
        return DeadlineReader(self.sock, self.deadline)


class DeadlineHTTPResponse(http.client.HTTPResponse):
    def __init__(self, sock, *args, deadline, **kwargs):
        super().__init__(_ResponseSocket(sock, deadline), *args, **kwargs)


class DeadlineHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.response_class = partial(DeadlineHTTPResponse,
                                      deadline=clock.monotonic() + float(self.timeout))


class DeadlineHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(DeadlineHTTPSConnection, req, context=self._context)
