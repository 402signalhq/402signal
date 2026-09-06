"""Loopback-only slow sender tests; one connection per case."""
import socket
import threading
import time
import unittest
from live402.io_deadline import DeadlineReader, DeadlineHTTPResponse


class AbsoluteReadTests(unittest.TestCase):
    def _slow_read(self, operation, prefix=b''):
        reader, writer = socket.socketpair()
        reader.settimeout(0.3)
        stopped = threading.Event()
        def send():
            try:
                if prefix:
                    writer.sendall(prefix)
                while not stopped.wait(0.03):
                    writer.sendall(b'x')
            except OSError:
                pass
        sender = threading.Thread(target=send)
        sender.start()
        start = time.monotonic()
        try:
            with self.assertRaises(TimeoutError):
                operation(reader, start + 0.2)
            self.assertLess(time.monotonic() - start, 0.7)
        finally:
            stopped.set()
            reader.close()
            writer.close()
            sender.join(1)
        self.assertFalse(sender.is_alive())

    def test_dripping_request_headers_have_absolute_deadline(self):
        def read(sock, end):
            with DeadlineReader(sock, end) as f:
                f.readline(65537)
        self._slow_read(read)

    def test_dripping_request_body_has_absolute_deadline(self):
        def read(sock, end):
            with DeadlineReader(sock, end) as f:
                f.read(65536)
        self._slow_read(read)

    def test_dripping_outbound_headers_have_absolute_deadline(self):
        def read(sock, end):
            with DeadlineHTTPResponse(sock, deadline=end) as response:
                response.begin()
        self._slow_read(read, b'HTTP/1.1 200 OK\r\nX-Slow: ')

    def test_dripping_outbound_body_has_absolute_deadline(self):
        def read(sock, end):
            with DeadlineHTTPResponse(sock, deadline=end) as response:
                response.begin()
                response.read(65536)
        self._slow_read(read, b'HTTP/1.1 200 OK\r\nContent-Length: 65536\r\n\r\n')
