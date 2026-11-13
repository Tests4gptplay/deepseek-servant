#!/usr/bin/env python3
"""Resident, private stdio Git object service. No credential helpers/object files.
The TypeScript owner controls authority, receipts, lifetime and cancellation.
"""
import sys

# getaddrinfo is a synchronous platform resolver and cannot be cancelled safely
# inside a Python worker thread. A short-lived, credential-free child owns only
# that call. EOF on its parent pipe also ends it if the helper is killed.
if __name__ == '__main__' and sys.argv[1:] == ['--resolve']:
    import json, socket, threading, os
    request = json.loads(sys.stdin.buffer.readline())
    def parent_closed():
        sys.stdin.buffer.read()
        os._exit(0)
    threading.Thread(target=parent_closed, daemon=True).start()
    try:
        result = {'addresses': socket.getaddrinfo(request['host'], request['port'], request['family'], socket.SOCK_STREAM)}
    except OSError as error:
        result = {'error': error.errno}
    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()
    os._exit(0)

import json
import io
import zlib
import logging
import os
import re
import ssl
import socket
import threading
import weakref
import struct
import subprocess
import selectors
import errno
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit, urlunsplit, unquote
from urllib.request import getproxies_environment, proxy_bypass_environment
import urllib3
from urllib3.util.ssltransport import SSLTransport
from dulwich.client import Urllib3HttpGitClient
from dulwich.config import ConfigDict
from dulwich.object_store import MemoryObjectStore
from dulwich.objects import Blob, Commit, Tree, ShaFile
from dulwich.pack import (PackData, PackStreamReader, UnpackedObject, OFS_DELTA, REF_DELTA, apply_delta,
    read_pack_header, take_msb_bytes, _decode_object_header, _decode_delta_base_offset)
from dulwich.refs import check_ref_format, DictRefsContainer
from dulwich.repo import MemoryRepo

CHUNK_BYTES = 64 * 1024  # Transport window, never a total payload limit.
HEADER = struct.Struct('>BQI')
JSON_PART, JSON_END, BYTES, BYTES_END, INPUT_READY, CANCEL = 74, 77, 66, 69, 65, 67
ZERO = b'0' * 40
logging.disable(logging.CRITICAL)

class BackendError(Exception):
    def __init__(self, kind, message):
        self.kind, self.safe_message = kind, message
        super().__init__(message)


# A control reader remains responsive while a worker is blocked on HTTP. Socket
# interruption is request-scoped, never process-wide. Ownership is checked under
# one tiny lock so an idle keep-alive socket reused by B cannot be killed by A.
_socket_lock = threading.RLock()
_socket_owners = weakref.WeakKeyDictionary()
_current = threading.local()
class Operation:
    def __init__(self, request=None):
        self.event = threading.Event()
        self.lock = threading.RLock()
        self.sockets = set()
        self.processes = set()
        self.request = request
        self.http_phase = None
        self.http_status = None
        self.response_observed = False
        self.wakeups = set()
    def check(self):
        if self.event.is_set():
            raise BackendError('cancelled', 'Memory Git operation was cancelled.')
    def track(self, sock):
        # TLS-in-TLS is a BIO wrapper, not a shutdown-capable socket. Register
        # its actual transport so reuse transfers the same physical ownership
        # and cancellation interrupts the underlying read/write/handshake.
        while isinstance(sock, SSLTransport):
            sock = sock.socket
        if sock is None:
            return
        with _socket_lock:
            _socket_owners[sock] = self
            self.sockets.add(sock)
        if self.event.is_set():
            self.interrupt()
            self.check()
    def track_process(self, process):
        with self.lock:
            self.processes.add(process)
            if self.event.is_set() and process.poll() is None:
                try: process.kill()
                except OSError: pass
    def interrupt(self):
        with self.lock:
            self.event.set()
            if self.request is not None:
                self.request.pop('token', None)
            wakeups = list(self.wakeups)
            for process in self.processes:
                if process.poll() is None:
                    try: process.kill()
                    except OSError: pass
        for wakeup in wakeups:
            wakeup()
        with _socket_lock:
            for sock in self.sockets:
                if _socket_owners.get(sock) is self:
                    try: sock.shutdown(socket.SHUT_RDWR)
                    except OSError: pass
    def finish(self):
        with _socket_lock:
            for sock in self.sockets:
                if _socket_owners.get(sock) is self:
                    _socket_owners.pop(sock, None)
            self.sockets.clear()
        self.request = None

def current():
    return getattr(_current, 'operation', None)

def check_cancelled():
    operation = current()
    if operation is not None:
        operation.check()

def resolve_addresses(host, port):
    check_cancelled()
    operation = current()
    child = subprocess.Popen([sys.executable, '-I', '-B', os.path.abspath(__file__), '--resolve'],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, close_fds=True,
        env={key: value for key, value in os.environ.items() if re.fullmatch(
            r'PATH|PATHEXT|SystemRoot|SystemDrive|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|LANG|LC_ALL|LC_CTYPE|TZ', key, re.I)},
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
    if operation is not None: operation.track_process(child)
    try:
        check_cancelled()
        child.stdin.write(json.dumps({'host': host, 'port': port, 'family': urllib3.util.connection.allowed_gai_family()}).encode() + b'\n')
        child.stdin.flush()
        data = child.stdout.read()
        child.wait()
        check_cancelled()
        result = json.loads(data)
        if 'error' in result: raise socket.gaierror(result['error'], 'Address resolution failed')
        return result['addresses']
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
        child.stdin.close(); child.stdout.close()
        if operation is not None:
            with operation.lock: operation.processes.discard(child)


def connect_owned(sock, address):
    operation = current()
    if operation is not None: operation.track(sock)
    check_cancelled()
    sock.setblocking(False)
    status = sock.connect_ex(tuple(address))
    in_progress = (errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY, getattr(errno, 'WSAEWOULDBLOCK', 10035))
    if status == 0: return
    if status not in in_progress: raise OSError(status, 'Connection failed')
    reader, writer = socket.socketpair()
    writer.setblocking(False)
    def wake():
        try: writer.send(b'!')
        except OSError: pass
    if operation is not None:
        with operation.lock: operation.wakeups.add(wake)
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(sock, selectors.EVENT_WRITE)
            selector.register(reader, selectors.EVENT_READ)
            check_cancelled()
            selector.select()
            check_cancelled()
            status = sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
            if status: raise OSError(status, 'Connection failed')
    finally:
        if operation is not None:
            with operation.lock: operation.wakeups.discard(wake)
        reader.close(); writer.close()


class OwnedSSLContext(ssl.SSLContext):
    def wrap_socket(self, *args, **kwargs):
        handshake = kwargs.pop('do_handshake_on_connect', True)
        sock = super().wrap_socket(*args, do_handshake_on_connect=False, **kwargs)
        if current() is not None: current().track(sock)
        try:
            check_cancelled()
            if handshake: sock.do_handshake()
            return sock
        except BaseException:
            sock.close()
            raise


class TrackedConnection:
    def _new_conn(self):
        check_cancelled()
        host = self._dns_host.strip('[]')
        host.encode('idna')  # Preserve urllib3's actual DNS-name constraint.
        try:
            addresses = resolve_addresses(host, self.port)
            error = None
            for family, kind, protocol, _canonical, address in addresses:
                sock = socket.socket(family, kind, protocol)
                try:
                    for option in self.socket_options or ():
                        sock.setsockopt(*option)
                    if self.source_address: sock.bind(self.source_address)
                    connect_owned(sock, address)
                    sock.settimeout(self.timeout)
                    sys.audit('http.client.connect', self, self.host, self.port)
                    return sock
                except OSError as failure:
                    error = failure; sock.close(); check_cancelled()
                except BaseException:
                    sock.close(); raise
            if error is not None: raise error
            raise OSError('Address resolution returned no addresses')
        except socket.gaierror as error:
            raise urllib3.exceptions.NameResolutionError(self.host, self, error) from error
        except OSError as error:
            raise urllib3.exceptions.NewConnectionError(self, 'Connection failed') from error
    def connect(self):
        check_cancelled()
        super().connect()
        if current() is not None: current().track(self.sock)
    def request(self, *args, **kwargs):
        check_cancelled()
        if current() is not None: current().track(self.sock)
        return super().request(*args, **kwargs)
class TrackedHTTPConnection(TrackedConnection, urllib3.connection.HTTPConnection): pass
class TrackedHTTPSConnection(TrackedConnection, urllib3.connection.HTTPSConnection): pass
class TrackedHTTPPool(urllib3.HTTPConnectionPool): ConnectionCls = TrackedHTTPConnection
class TrackedHTTPSPool(urllib3.HTTPSConnectionPool): ConnectionCls = TrackedHTTPSConnection

def tracked(pool):
    pool.pool_classes_by_scheme = {'http': TrackedHTTPPool, 'https': TrackedHTTPSPool}
    return pool

def oid(value):
    if not isinstance(value, str) or not re.fullmatch('[0-9a-f]{40}', value):
        raise BackendError('invalid', 'The memory Git backend requires a SHA-1 object id.')
    return value.encode('ascii')


class StrictMemoryStore(MemoryObjectStore):
    """Validate the WHOLE pack and every inflated object before publishing any.
    Delta bases may be borrowed from confirmed immutable objects, never mutated.
    Stock MemoryObjectStore's spooled temporary file is never used.
    """
    def __init__(self, base=None):
        super().__init__()
        self.base = base

    @staticmethod
    def copy_object(obj):
        # Dulwich's default copy joins all raw chunks first. Clone the object
        # and its chunk list while sharing only immutable bytes, not mutable
        # Blob/Tree/Commit instances or whole-body serialization copies.
        return ShaFile.from_raw_chunks(obj.type_num, list(obj.as_raw_chunks()), object_format=obj.object_format)

    def __getitem__(self, name):
        return self.copy_object(self._data[self._to_hexsha(name)])

    def add_object(self, obj):
        self._data[obj.id] = self.copy_object(obj)

    def get_raw(self, name):
        try:
            return super().get_raw(name)
        except KeyError:
            if self.base is not None:
                return self.base.get_raw(name)
            raise

    def add_pack(self):
        stream = StreamingPack(self)
        def commit():
            try:
                staged = stream.finish()
                stream.check()
                # The complete checksum and every object were checked. No
                # object becomes visible before this atomic publication.
                self._data.update(staged)
            finally:
                stream.close()
        return stream, commit, stream.close


class ObjectStreamReader(PackStreamReader):
    """Pinned pack grammar with bounded zlib input/output windows.

    Dulwich's general unpacker retains compressed chunks even when callers do
    not request them. This streaming path retains only actual object content.
    """
    def read_objects(self):
        _version, self._num_objects = read_pack_header(self.read)
        for _ in range(self._num_objects):
            check_cancelled()
            offset = self.offset
            raw, _crc = take_msb_bytes(self.read)
            kind, size = _decode_object_header(raw)
            base = None
            if kind == OFS_DELTA:
                raw, _crc = take_msb_bytes(self.read)
                base = _decode_delta_base_offset(raw)
            elif kind == REF_DELTA:
                base = self.read(self._hash_size)
            decoder, chunks, length, unused = zlib.decompressobj(), [], 0, b''
            while not decoder.eof:
                compressed = self.recv(CHUNK_BYTES)
                if not compressed: raise EOFError('Incomplete compressed Git object')
                while compressed:
                    check_cancelled()
                    decoded = decoder.decompress(compressed, CHUNK_BYTES)
                    length += len(decoded)
                    if length > size: raise ValueError('Git object exceeds its declared length')
                    chunks.append(decoded)
                    compressed = decoder.unconsumed_tail
                    if decoder.eof:
                        unused = decoder.unused_data
                        break
            if length != size: raise ValueError('Git object differs from its declared length')
            self._rbuf = io.BytesIO(unused + self._rbuf.read())
            yield UnpackedObject(kind, delta_base=base, decomp_len=size, decomp_chunks=chunks,
                offset=offset, hash_func=self.hash_func)
        if self._buf_len() < self._hash_size:
            self.read(self._hash_size)


class StreamingPack:
    """Pull Dulwich's parser from one bounded transport window.

    Compressed pack bytes are consumed and discarded, never kept as a whole
    pack or spooled to disk. Only immutable objects and unresolved delta input
    remain staged until the complete pack checksum has passed.
    """
    check = PackData.check  # Preserve Dulwich's pack checksum comparison.

    def __init__(self, store):
        self.store, self.operation = store, current()
        self.condition = threading.Condition()
        self.chunks, self.buffered, self.peak_buffered = deque(), 0, 0
        self.size, self.eof, self.closed, self.error = 0, False, False, None
        self.staged, self.reader, self.empty = {}, None, False
        if self.operation is not None:
            with self.operation.lock: self.operation.wakeups.add(self.wake)
        self.worker = threading.Thread(target=self.parse, name='dss-pack', daemon=True)
        self.worker.start()
    def wake(self):
        with self.condition: self.condition.notify_all()
    def check_open(self):
        if self.operation is not None: self.operation.check()
        if self.error is not None: raise self.error
        if self.closed: raise BackendError('cancelled', 'Git pack reception was stopped.')
    def tell(self): return self.size
    def write(self, chunk):
        for offset in range(0, len(chunk), CHUNK_BYTES):
            part = bytes(memoryview(chunk)[offset:offset + CHUNK_BYTES])
            with self.condition:
                while self.buffered:
                    self.check_open(); self.condition.wait()
                self.check_open()
                self.chunks.append(part); self.buffered = len(part)
                self.size += len(part); self.peak_buffered = max(self.peak_buffered, self.buffered)
                self.condition.notify_all()
        return len(chunk)
    def read_some(self, size):
        with self.condition:
            while not self.chunks and not self.eof:
                self.check_open(); self.condition.wait()
            self.check_open()
            if not self.chunks: return b''
            chunk = self.chunks.popleft()
            result, rest = chunk[:size], chunk[size:]
            if rest: self.chunks.appendleft(rest)
            self.buffered -= len(result); self.condition.notify_all()
            return result
    def read_all(self, size):
        chunks, remaining = [], size
        while remaining:
            chunk = self.read_some(remaining)
            if not chunk: raise EOFError('Incomplete Git pack')
            chunks.append(chunk); remaining -= len(chunk)
        return b''.join(chunks)
    def parse(self):
        _current.operation = self.operation
        try:
            # Empty fetches are valid when all requested objects already exist.
            with self.condition:
                while not self.chunks and not self.eof:
                    self.check_open(); self.condition.wait()
                self.check_open()
                if not self.chunks:
                    self.empty = True
                    return
            self.reader = ObjectStreamReader(self.store.object_format.hash_func, self.read_all, self.read_some)
            offsets, pending_offsets, pending_refs = {}, defaultdict(list), defaultdict(list)
            def available(name):
                obj = self.staged.get(name)
                if obj is not None: return obj
                store = self.store
                while store is not None:
                    obj = store._data.get(name)
                    if obj is not None: return obj
                    store = getattr(store, 'base', None)
                return None
            def materialize(unpacked, base=None):
                todo = [(unpacked, base)]
                while todo:
                    check_cancelled()
                    item, parent = todo.pop()
                    if parent is None:
                        obj = ShaFile.from_raw_chunks(item.obj_type_num, item.obj_chunks, object_format=self.store.object_format)
                    else:
                        chunks = apply_delta(parent.as_raw_chunks(), item.decomp_chunks)
                        if parent.type_num != Blob.type_num and not sum(map(len, chunks)):
                            raise ValueError('Delta resolved to empty non-blob object')
                        obj = ShaFile.from_raw_chunks(parent.type_num, chunks, object_format=self.store.object_format)
                    obj.check()
                    name = obj.id
                    self.staged[name] = obj; offsets[item.offset] = obj
                    todo.extend((child, obj) for child in pending_offsets.pop(item.offset, []))
                    todo.extend((child, obj) for child in pending_refs.pop(bytes.fromhex(name.decode('ascii')), []))
            for unpacked in self.reader.read_objects():
                check_cancelled()
                if unpacked.pack_type_num == OFS_DELTA:
                    base_offset = unpacked.offset - unpacked.delta_base
                    base = offsets.get(base_offset)
                    if base is None: pending_offsets[base_offset].append(unpacked)
                    else: materialize(unpacked, base)
                elif unpacked.pack_type_num == REF_DELTA:
                    base = available(unpacked.delta_base.hex().encode('ascii'))
                    if base is None: pending_refs[unpacked.delta_base].append(unpacked)
                    else: materialize(unpacked, base)
                else: materialize(unpacked)
            if pending_offsets or pending_refs: raise ValueError('Git pack has unresolved deltas')
            # PackStreamReader may leave its trailer buffered. Anything beyond
            # exactly that trailer, or any later input, is not this pack.
            if self.reader._buf_len() not in (0, self.store.object_format.oid_length) or self.read_some(1):
                raise ValueError('Git pack has trailing bytes')
        except BaseException as error:
            with self.condition:
                self.error = error; self.condition.notify_all()
        finally:
            _current.operation = None
    def calculate_checksum(self):
        return b'' if self.empty else self.reader.sha.digest()
    def get_stored_checksum(self):
        return b'' if self.empty else bytes(self.reader._trailer)
    def finish(self):
        with self.condition:
            self.eof = True; self.condition.notify_all()
        self.worker.join()
        self.check_open()
        return self.staged
    def close(self):
        with self.condition:
            self.closed = True; self.chunks.clear(); self.buffered = 0; self.condition.notify_all()
        self.worker.join()
        if self.operation is not None:
            with self.operation.lock: self.operation.wakeups.discard(self.wake)
        self.staged = {}


def memory():
    repo = MemoryRepo()
    repo.object_store = StrictMemoryStore()
    # No local ref history is authoritative. MemoryRepo default reflog logger
    # points back to the repo, retaining retired stores until cyclic GC, and
    # appends forever on warm observations. Use an unlogged in-memory ref map.
    repo.refs = DictRefsContainer({})
    return repo


def make_pool(url):
    # Supported host routing/CA selectors only. No inherited key logging, auth
    # helpers, gitconfig, TLS bypass or system trust changes.
    context = OwnedSSLContext(ssl.PROTOCOL_TLS_CLIENT)
    cafile = os.environ.get('GIT_SSL_CAINFO') or os.environ.get('SSL_CERT_FILE') or os.environ.get('CURL_CA_BUNDLE')
    capath = os.environ.get('GIT_SSL_CAPATH') or os.environ.get('SSL_CERT_DIR')
    if cafile or capath:
        context.load_verify_locations(cafile=cafile, capath=capath)
    else:
        context.load_default_certs()
    kwargs = dict(ssl_context=context, cert_reqs='CERT_REQUIRED', retries=False,
                  timeout=urllib3.Timeout(connect=None, read=None))
    parsed = urlsplit(url)
    proxies = getproxies_environment()
    proxy = None if proxy_bypass_environment(parsed.hostname, proxies) else proxies.get(parsed.scheme, proxies.get('all'))
    if not proxy:
        return tracked(urllib3.PoolManager(**kwargs))
    p = urlsplit(proxy)
    if p.scheme not in ('http', 'https') or not p.hostname:
        raise BackendError('invalid', 'Memory Git supports only HTTP/HTTPS CONNECT proxy routing.')
    headers = urllib3.make_headers(proxy_basic_auth=unquote(p.username) + ':' + unquote(p.password or '')) if p.username is not None else {}
    host = p.hostname if ':' not in p.hostname else '[' + p.hostname + ']'
    clean_proxy = urlunsplit((p.scheme, host + (':' + str(p.port) if p.port else ''), p.path, '', ''))
    if p.scheme == 'https':
        proxy_context = OwnedSSLContext(ssl.PROTOCOL_TLS_CLIENT)
        if os.environ.get('GIT_PROXY_SSL_CAINFO'):
            proxy_context.load_verify_locations(cafile=os.environ['GIT_PROXY_SSL_CAINFO'])
        else:
            proxy_context.load_default_certs()
        kwargs['proxy_ssl_context'] = proxy_context
    return tracked(urllib3.ProxyManager(clean_proxy, proxy_headers=headers, **kwargs))


class BoundPool:
    def __init__(self, pool, remote):
        self.pool, self.remote, self.headers = pool, remote.rstrip('/'), pool.headers
    def request(self, method, url, **kwargs):
        # Redirects may neither change the destination nor forward credentials.
        allowed = (method == 'GET' and url in (self.remote + '/info/refs?service=git-upload-pack', self.remote + '/info/refs?service=git-receive-pack')) or (method == 'POST' and url in (self.remote + '/git-upload-pack', self.remote + '/git-receive-pack'))
        if not allowed:
            raise BackendError('invalid', 'Git requested an unauthorized HTTP endpoint.')
        check_cancelled()
        operation = current()
        if operation is not None:
            # Endpoints were checked above. Retain enums and numbers only, never
            # URL, auth headers, response body or the dependency exception text.
            operation.http_phase = 'advertisement' if method == 'GET' else ('upload-pack' if url.endswith('/git-upload-pack') else 'receive-pack')
            operation.http_status = None
            operation.response_observed = False
        kwargs.update(redirect=False, retries=False)
        response = self.pool.request(method, url, **kwargs)
        if operation is not None:
            operation.response_observed = True
            if type(response.status) is int and 100 <= response.status <= 599:
                operation.http_status = response.status
        if response.status in (403, 404):
            response.close()
            raise BackendError('auth', 'Git authentication or repository permission failed.')
        return response
    def clear(self):
        pass  # The helper owns the shared pool lifetime, not one token-bound client.


class StrictGitClient(Urllib3HttpGitClient):
    # Transport hooks preserve filtered reads and explicit acknowledgement. No
    # process-global warnings filters/logging state participates in correctness.
    @staticmethod
    def _warn_filter_objects():
        raise BackendError('invalid', 'Remote Git service does not support filtered object transport.')
    def _negotiate_receive_pack_capabilities(self, server_capabilities):
        capabilities, agent = super()._negotiate_receive_pack_capabilities(server_capabilities)
        if b'report-status' not in capabilities:
            raise BackendError('invalid', 'Git publication requires explicit report-status acknowledgements.')
        return capabilities, agent
    def _handle_receive_pack_tail(self, proto, capabilities, progress=None):
        result = super()._handle_receive_pack_tail(proto, capabilities, progress)
        parser = self._report_status_parser
        # Dulwich 1.2.21 accepts an absent unpack status and silently ignores
        # malformed ref lines. Its lack of an exception is not an ACK. With
        # sideband, require the inner status stream flush too; without sideband
        # super() already consumes the outer flush (EOF raises).
        if parser is None or parser._pack_status != b'unpack ok' or (
            (b'side-band-64k' in capabilities or self.protocol_version == 2) and not parser._done
        ):
            raise BackendError('transport', 'Git publication acknowledgement was incomplete.')
        seen = set()
        for line in parser._ref_statuses:
            fields = line.split(b' ', 2)
            if not (len(fields) == 2 and fields[0] == b'ok' or len(fields) == 3 and fields[0] == b'ng' and fields[2]):
                raise BackendError('transport', 'Git publication acknowledgement was malformed.')
            ref = fields[1]
            if not check_ref_format(ref) or ref in seen:
                raise BackendError('transport', 'Git publication acknowledgement was ambiguous.')
            seen.add(ref)
        return result
    def _discover_references(self, *args, **kwargs):
        result = super()._discover_references(*args, **kwargs)
        if self.dumb:
            raise BackendError('invalid', 'Memory Git requires the smart HTTP protocol.')
        if any(capability.startswith(b'object-format=') and capability.strip() != b'object-format=sha1' for capability in result[1]):
            raise BackendError('invalid', 'The memory Git backend currently supports SHA-1 repositories only.')
        return result

class Engine:
    def __init__(self):
        self.stores = {0: memory()}
        self.next_store = 1
        self.lock = threading.RLock()
        self.pool = None
        self.remote = None

    def client(self, command, request):
        remote = command['remote']
        parsed = urlsplit(remote)
        fixture = bool(request.get('fixture'))
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise BackendError('invalid', 'Credential-bearing or ambiguous Git URLs are prohibited.')
        if not (parsed.scheme == 'https' and parsed.hostname == 'github.com' or fixture and parsed.scheme in ('http', 'https') and parsed.hostname in ('127.0.0.1', '::1', 'localhost')):
            raise BackendError('invalid', 'Memory Git requires the authorized HTTPS endpoint or an isolated loopback fixture.')
        if self.remote is not None and self.remote != remote:
            raise BackendError('invalid', 'A helper cannot change repository scope.')
        with self.lock:
            if self.pool is None:
                self.remote, self.pool = remote, make_pool(remote)
        client = StrictGitClient(urlunsplit((parsed.scheme, parsed.netloc, '/', '', '')),
            pool_manager=BoundPool(self.pool, remote), config=ConfigDict(),
            username='x-access-token', password=request.get('token') or '', include_tags=False, timeout=None)
        return client, parsed.path

    def receive(self, repo, client, path, wants, *, tip=None, filter_spec=b'blob:none', protocol=2, prefixes=None, depth=1):
        stage = StrictMemoryStore(repo.object_store)
        stream, commit, abort = stage.add_pack()
        def write(chunk):
            check_cancelled()
            return stream.write(chunk)
        try:
            walker = repo.get_graph_walker(heads=[tip] if tip else [])
            result = client.fetch_pack(path, wants, walker, write, depth=depth,
                filter_spec=filter_spec, protocol_version=protocol, ref_prefix=prefixes)
            check_cancelled()
            commit()
            check_cancelled()
            # Publish confirmed objects and shallow metadata together. Neither
            # changes until this receive and validation work has succeeded.
            operation = current()
            with operation.lock if operation is not None else self.lock:
                check_cancelled()
                with self.lock:
                    repo.object_store._data.update(stage._data)
                    repo.update_shallow(result.new_shallow, result.new_unshallow)
            return result
        except BaseException:
            abort()
            raise

    def replacement(self, repo, request):
        selected = set(oid(value) for value in request.get('blobs', []))
        candidate = memory()
        roots = []
        for root in request['roots']:
            head = oid(root['head'])
            commit = repo[head]
            if not isinstance(commit, Commit) or root.get('tree') and oid(root['tree']) != commit.tree:
                raise BackendError('invalid', 'Retained snapshot does not match its commit.')
            candidate.object_store.add_object(commit)
            # Iterative traversal has no recursive closure cycle retaining the
            # source/candidate repositories until cyclic GC. Released old stores
            # can be reclaimed immediately even with large, untracked blobs.
            remaining = [commit.tree]
            while remaining:
                check_cancelled()
                tree_id = remaining.pop()
                if tree_id in candidate.object_store:
                    continue
                tree = repo[tree_id]
                if not isinstance(tree, Tree):
                    raise BackendError('invalid', 'A retained tree has the wrong object type.')
                candidate.object_store.add_object(tree)
                for entry in tree.iteritems():
                    if entry.mode == 0o040000:
                        remaining.append(entry.sha)
                    elif entry.mode != 0o160000 and entry.sha in selected and entry.sha in repo.object_store:
                        candidate.object_store.add_object(repo[entry.sha])
            roots.append({'head': head.decode(), 'tree': commit.tree.decode()})
            candidate.update_shallow([head], [])
        check_cancelled()
        with self.lock:
            store = self.next_store
            self.next_store += 1
            self.stores[store] = candidate
        return {'store': store, 'objects': len(candidate.object_store._data), 'packBytes': 0,
                'rawBytes': sum(obj.raw_length() for obj in candidate.object_store._data.values()), 'roots': roots}

    def execute(self, request):
        check_cancelled()
        if request['op'] == 'hello':
            import dulwich
            return {'python': list(sys.version_info[:3]), 'dulwich': list(dulwich.__version__), 'urllib3': urllib3.__version__}
        if request['op'] == 'diagnostics':
            with self.lock:
                stores = list(self.stores.items())
                return {'pid': os.getpid(), 'stores': [{'store': key, 'objects': len(repo.object_store._data), 'rawBytes': sum(obj.raw_length() for obj in repo.object_store._data.values())} for key, repo in stores]}
        store = request.get('store', 0)
        if request['op'] == 'release':
            with self.lock:
                self.stores.pop(store, None)
            return None
        repo = self.stores[store]
        if request['op'] == 'storageBytes':
            # Existing object publication uses this lock. Capture references to
            # immutable objects, then calculate outside the short capture step.
            with self.lock:
                objects = tuple(repo.object_store._data.values())
            return sum(obj.raw_length() for obj in objects)
        if request['op'] == 'replacement':
            return self.replacement(repo, request)
        command = request['command']
        op = command['op']
        chunks = request.get('input', [])
        data = b''.join(chunks) if op != 'writeBlob' else None
        if op in ('fetchHead', 'push') and not check_ref_format(command['ref'].encode('utf8')):
            raise BackendError('invalid', 'Invalid Git branch name.')
        if op in ('fetchHead', 'fetchMetadata', 'ensureObjects', 'push'):
            client, path = self.client(command, request)
            try:
                return self.network(repo, client, path, command)
            finally:
                # Token exists only in the current input/client. Do not retain it
                # across calls or on errors; immutable objects contain no token.
                client._auth_header = None
                client._password = None
                client._username = None
                client._auth_origin = None
                client.close()
        if op == 'readObject':
            obj = repo[oid(command['id'])]
            if obj.type_name.decode() != command['kind']:
                raise BackendError('invalid', 'Git object type mismatch.')
            return ByteResult(obj.as_raw_chunks())
        if op == 'readTree':
            tree = repo[oid(command['id'])]
            if not isinstance(tree, Tree):
                raise BackendError('invalid', 'Git tree object type mismatch.')
            return b''.join(('%06o %s %s\t' % (entry.mode, 'tree' if entry.mode == 0o040000 else 'commit' if entry.mode == 0o160000 else 'blob', entry.sha.decode())).encode() + entry.path + b'\0' for entry in tree.iteritems())
        if op == 'writeBlob':
            obj = Blob.from_raw_chunks(Blob.type_num, chunks, object_format=repo.object_store.object_format)
        elif op == 'writeTree':
            obj = Tree()
            for item in data.split(b'\0'):
                if not item:
                    continue
                header, name = item.split(b'\t', 1)
                mode, kind, sha = header.split(b' ')
                if b'/' in name or name in (b'', b'.', b'..'):
                    raise BackendError('invalid', 'Invalid tree entry name.')
                obj.add(name, int(mode, 8), oid(sha.decode()))
        elif op == 'writeCommit':
            obj = Commit()
            obj.tree = oid(command['tree'])
            obj.parents = [oid(command['parent'])] if command['parent'] else []
            obj.author = obj.committer = (command['identity'] + ' <' + command['email'] + '>').encode('utf8')
            obj.author_time = obj.commit_time = command['timestamp']
            obj.author_timezone = obj.commit_timezone = 0
            obj.message = data if data.endswith(b'\n') else data + b'\n'
        else:
            raise BackendError('invalid', 'Unknown memory Git operation.')
        obj.check()
        with self.lock:
            check_cancelled()
            repo.object_store.add_object(obj)
        if op == 'writeCommit':
            return json.dumps({'id': obj.id.decode('ascii'), 'tree': obj.tree.decode('ascii'),
                'parents': [parent.decode('ascii') for parent in obj.parents],
                'message': obj.message.decode('utf8'), 'timestamp': obj.commit_time}, separators=(',', ':')).encode('utf8')
        return obj.id + b'\n'

    def network(self, repo, client, path, command):
        op = command['op']
        if op == 'fetchHead':
            ref = command['ref'].encode('utf8')
            def wants(refs, depth=None):
                head = refs.get(ref)
                if head is None:
                    return []
                oid(head.decode())
                return [head] if head not in repo.object_store else []
            tip = oid(command['tip']) if command.get('tip') else None
            result = self.receive(repo, client, path, wants, tip=tip, prefixes=[ref])
            head = result.refs.get(ref)
            if head is None:
                return b''
            with self.lock:
                check_cancelled()
                repo.refs[ref] = head
            return head
        if op == 'fetchMetadata':
            target = oid(command['revision'])
            self.receive(repo, client, path, lambda refs, depth=None: [target])
            return b''
        if op == 'ensureObjects':
            ids = [oid(name) for name in command['ids']]
            depth = command.get('commitDepth')
            if depth is not None and (type(depth) is not int or not 1 <= depth <= 64 or command['kind'] != 'commit' or len(ids) != 1):
                raise BackendError('invalid', 'Commit history requires one commit and a bounded depth.')
            missing = [name for name in ids if name not in repo.object_store]
            if missing:
                blobs = command['kind'] == 'blob'
                self.receive(repo, client, path, lambda refs, depth=None: missing,
                    filter_spec=None if blobs else b'tree:0', protocol=1 if blobs else 2, depth=depth or 1)
            for name in ids:
                if name not in repo.object_store or repo[name].type_name.decode() != command['kind']:
                    raise BackendError('invalid', 'Git service did not supply the requested object.')
            if depth is not None:
                # Mark only existing first-parent commits as locally available.
                # Trees/blobs and branch authority are deliberately not claimed.
                present, cursor = [], ids[0]
                while cursor in repo.object_store and len(present) < depth:
                    check_cancelled()
                    obj = repo[cursor]
                    if obj.type_name != b'commit' or cursor in present:
                        raise BackendError('invalid', 'Git service supplied invalid commit history.')
                    present.append(cursor)
                    if not obj.parents:
                        break
                    cursor = obj.parents[0]
                return b'\n'.join(present)
            return b''
        if op == 'push':
            ref, commit = command['ref'].encode('utf8'), oid(command['commit'])
            expected = oid(command['expected']) if command['expected'] else ZERO
            if commit == expected:
                raise BackendError('invalid', 'Git publication must propose a new commit.')
            def update(refs):
                if refs.get(ref, ZERO) != expected:
                    error = BackendError('stale', 'Git compare-and-swap rejected a stale expected head.')
                    actual = refs.get(ref, ZERO)
                    if actual != ZERO and re.fullmatch(b'(?:[0-9a-f]{40}|[0-9a-f]{64})', actual):
                        error.advertised_head = actual.decode('ascii')
                    raise error
                return {ref: commit}
            result = client.send_pack(path, update, repo.generate_pack_data)
            if result.ref_status is None or ref not in result.ref_status:
                raise BackendError('transport', 'Git publication acknowledgement omitted the target branch.')
            if result.ref_status[ref] is not None:
                raise BackendError('rejected', 'The remote Git service rejected the prepared publication.')
            return b''
        raise BackendError('invalid', 'Unknown network operation.')


def failure_classification(error):
    operation = current()
    if operation is not None and operation.event.is_set():
        return {'kind': 'cancelled', 'message': 'Memory Git operation was cancelled.'}
    if isinstance(error, BackendError):
        failure = {'kind': error.kind, 'message': error.safe_message}
        if hasattr(error, 'advertised_head'):
            failure['advertisedHead'] = error.advertised_head
        return failure
    # Classify internally; never return dependency exception text, URLs or headers.
    name = type(error).__name__
    if name in ('HTTPUnauthorized', 'HTTPProxyUnauthorized', 'HTTPForbidden'):
        return {'kind': 'auth', 'message': 'Git authentication or permission failed.'}
    if 'incorrect old value provided' in str(error):
        return {'kind': 'stale', 'message': 'Git compare-and-swap rejected a stale expected head.'}
    return {'kind': 'transport', 'message': 'Memory Git operation failed (' + name + ').'}


def safe_failure(error):
    failure = failure_classification(error)
    operation = current()
    if operation is not None and operation.http_phase is not None:
        failure['phase'] = operation.http_phase
        failure['responseObserved'] = operation.response_observed
        if operation.http_status is not None:
            failure['status'] = operation.http_status
        if operation.http_status is not None and operation.http_status >= 400:
            category = 'http'
        elif isinstance(error, (urllib3.exceptions.SSLError, ssl.SSLError)):
            category = 'tls'
        elif isinstance(error, (urllib3.exceptions.TimeoutError, TimeoutError)):
            category = 'timeout'
        elif isinstance(error, (urllib3.exceptions.ProtocolError, ConnectionError, OSError)):
            category = 'connection'
        else:
            category = 'protocol' if type(error).__name__ == 'GitProtocolError' else 'other'
        failure['category'] = category
    return failure


class ByteResult:
    def __init__(self, chunks):
        self.chunks = chunks
        self.size = sum(len(chunk) for chunk in chunks)


class InputBody:
    # Only running workers grant body input. Queued requests keep metadata, not
    # eagerly materialized payloads. Blob chunks become the immutable object.
    def __init__(self, expected, operation):
        self.expected, self.operation = expected, operation
        self.chunks, self.size, self.done = [], 0, False
        self.condition = threading.Condition()
        with operation.lock:
            operation.wakeups.add(self.wake)
    def wake(self):
        with self.condition: self.condition.notify_all()
    def append(self, chunk):
        with self.condition:
            if not self.operation.event.is_set():
                self.size += len(chunk)
                if self.size > self.expected: raise ValueError('Input exceeds declared length')
                self.chunks.append(chunk)
    def end(self):
        with self.condition:
            self.done = True
            self.condition.notify_all()
    def take(self):
        try:
            with self.condition:
                while not self.done:
                    self.operation.check()
                    self.condition.wait()
                self.operation.check()
                if self.size != self.expected: raise ValueError('Incomplete input')
                return self.chunks
        finally:
            with self.operation.lock: self.operation.wakeups.discard(self.wake)


def main():
    engine = Engine()
    output_lock, pending_lock = threading.Lock(), threading.Lock()
    pending, metadata, bodies, cancelled = {}, {}, {}, set()
    latest_identity = 0
    def packet(kind, identity, body=b''):
        with output_lock:
            sys.stdout.buffer.write(HEADER.pack(kind, identity, len(body)))
            sys.stdout.buffer.write(body)
            sys.stdout.buffer.flush()
    def json_result(identity, response):
        # iterencode avoids one complete serialized response copy. Split even a
        # large individual JSON field into transport windows.
        window = bytearray()
        for text in json.JSONEncoder(separators=(',', ':')).iterencode(response):
            encoded = text.encode('utf8')
            for offset in range(0, len(encoded), CHUNK_BYTES):
                piece = encoded[offset:offset + CHUNK_BYTES]
                if len(window) + len(piece) > CHUNK_BYTES:
                    packet(JSON_PART, identity, window); window.clear()
                window.extend(piece)
        packet(JSON_END, identity, window)

    def work(request, operation, body):
        identity = request['id']
        _current.operation = operation
        try:
            operation.check()
            if body is not None:
                packet(INPUT_READY, identity)
                request['input'] = body.take()
            result = engine.execute(request)
            operation.check()
            if isinstance(result, bytes): result = ByteResult([result])
            if isinstance(result, ByteResult):
                json_result(identity, {'bytes': result.size})
                # A terminal error can end this ID between byte packets. A
                # cancelled reader does not force the remaining body transfer.
                for chunk in result.chunks:
                    for offset in range(0, len(chunk), CHUNK_BYTES):
                        operation.check()
                        packet(BYTES, identity, memoryview(chunk)[offset:offset + CHUNK_BYTES])
                operation.check()
                packet(BYTES_END, identity)
            else:
                json_result(identity, {'result': result})
        except BaseException as error:
            json_result(identity, {'error': safe_failure(error)})
        finally:
            request.pop('token', None)
            request.pop('input', None)
            operation.finish()
            with pending_lock: pending.pop(identity, None)
            _current.operation = None
    def read_exact(size):
        data = sys.stdin.buffer.read(size)
        if len(data) != size: raise EOFError('Incomplete packet')
        return data
    # Bounded executors schedule work, never reject by pending request count.
    # The reader always handles cancellation independently of worker ownership.
    with ThreadPoolExecutor(max_workers=4, thread_name_prefix='dss-net') as network_workers, ThreadPoolExecutor(max_workers=2, thread_name_prefix='dss-objects') as local_workers:
        try:
            while True:
                header = sys.stdin.buffer.read(HEADER.size)
                if not header: break
                if len(header) != HEADER.size: raise EOFError('Incomplete header')
                kind, identity, size = HEADER.unpack(header)
                if size > CHUNK_BYTES: raise ValueError('Invalid transport window')
                chunk = read_exact(size)
                if kind == CANCEL:
                    if size: raise ValueError('Invalid cancel frame')
                    with pending_lock: operation = pending.get(identity)
                    if operation is not None: operation.interrupt()
                    elif identity in metadata or identity > latest_identity: cancelled.add(identity)
                elif kind in (JSON_PART, JSON_END):
                    latest_identity = max(latest_identity, identity)
                    metadata.setdefault(identity, []).append(chunk)
                    if kind != JSON_END: continue
                    request = json.loads(b''.join(metadata.pop(identity)))
                    request['id'] = identity
                    operation = Operation(request)
                    if identity in cancelled:
                        cancelled.remove(identity); operation.interrupt()
                    expected = request.pop('inputBytes', None)
                    if expected is not None and (type(expected) is not int or expected < 0): raise ValueError('Invalid input size')
                    body = None if expected is None else InputBody(expected, operation)
                    if body is not None: bodies[identity] = body
                    with pending_lock:
                        if identity in pending: raise ValueError('Duplicate request identity')
                        pending[identity] = operation
                    network = request.get('command', {}).get('op') in ('fetchHead', 'fetchMetadata', 'ensureObjects', 'push')
                    (network_workers if network else local_workers).submit(work, request, operation, body)
                elif kind == BYTES:
                    bodies[identity].append(chunk)
                elif kind == BYTES_END:
                    if size: raise ValueError('Invalid input ending')
                    bodies.pop(identity).end()
                else: raise ValueError('Unknown packet')
        except (EOFError, ValueError, KeyError, TypeError):
            pass
        finally:
            with pending_lock:
                operations = list(pending.values())
            for operation in operations: operation.interrupt()
    if engine.pool is not None: engine.pool.clear()

if __name__ == '__main__':
    main()
