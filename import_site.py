"""Fetch public server-rendered HTML for the existing studio preview."""
import html
import http.client
import ipaddress
import re
import socket
import ssl
from urllib.parse import urljoin, urlsplit, urlunsplit

MAX_BYTES = 200_000  # The studio sends the whole page back in its 512 KB apply request.


def normalize_url(raw):
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError('paste a URL first')
    raw = raw.strip()
    if '://' not in raw and not raw.startswith(('//', 'file:', 'data:', 'javascript:')):
        raw = 'https://' + raw
    try:
        parsed = urlsplit(raw)
        host = parsed.hostname
        port = parsed.port
    except ValueError:
        raise ValueError('invalid website URL') from None
    if parsed.scheme not in ('http', 'https') or not host or not re.fullmatch(r'[A-Za-z0-9.-]+', host) or \
       '.' not in host or parsed.username or parsed.password or port == 0 or parsed.fragment:
        raise ValueError('only public http(s) website URLs can be imported')
    if host.lower().endswith(('.local', '.internal', '.localhost', '.test')):
        raise ValueError('only public websites can be imported')
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        if not address.is_global:
            raise ValueError('only public websites can be imported')
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path or '/', parsed.query, ''))


def public_addresses(host, port):
    try:
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise ValueError('could not resolve website') from None
    if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
        raise ValueError('only public websites can be imported')
    return addresses


def request_page(url):
    """Connect to a validated resolved address, not a hostname resolved again later."""
    parsed = urlsplit(url)
    host = parsed.hostname
    port = parsed.port or (443 if parsed.scheme == 'https' else 80)
    addresses = public_addresses(host, port)

    class PinnedConnection(http.client.HTTPConnection):
        def connect(self):
            family, kind, proto, _, sockaddr = addresses[0]
            self.sock = socket.socket(family, kind, proto)
            self.sock.settimeout(self.timeout)
            try:
                self.sock.connect(sockaddr)
                if parsed.scheme == 'https':
                    self.sock = ssl.create_default_context().wrap_socket(self.sock, server_hostname=host)
            except BaseException:
                self.sock.close()
                raise

    connection = PinnedConnection(host, port, timeout=12)
    try:
        path = parsed.path or '/'
        if parsed.query:
            path += '?' + parsed.query
        connection.request('GET', path, headers={'User-Agent': 'Calliope URL Import', 'Accept': 'text/html'})
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read(MAX_BYTES + 1)
    finally:
        connection.close()


def sanitize(source, url):
    # Scripts cannot run in the sandbox, but remove them so they cannot rehydrate
    # and so the model does not waste its context on bundled JavaScript.
    source = re.sub(r'<script\b[^>]*>.*?</script\s*>', '', source, flags=re.I | re.S)
    source = re.sub(r'<script\b[^>]*?/?>', '', source, flags=re.I | re.S)
    source = re.sub(r'<base\b[^>]*>', '', source, flags=re.I | re.S)
    source = re.sub(r'<meta\b(?=[^>]*http-equiv\s*=\s*["\']?(?:refresh|content-security-policy))[^>]*>', '', source, flags=re.I | re.S)
    source = re.sub(r'<iframe\b[^>]*>.*?</iframe\s*>', '', source, flags=re.I | re.S)
    base = '<base href="' + html.escape(url, quote=True) + '">'
    if re.search(r'<head\b[^>]*>', source, flags=re.I):
        return re.sub(r'<head\b[^>]*>', lambda match: match.group() + base, source, count=1, flags=re.I)
    return base + source


def import_page(raw):
    url = normalize_url(raw)
    for _ in range(4):
        status, headers, body = request_page(url)
        headers = {key.lower(): value for key, value in headers.items()}
        if status in (301, 302, 303, 307, 308):
            location = headers.get('location')
            if not location:
                raise ValueError('redirect without a location')
            url = normalize_url(urljoin(url, location))
            continue
        if status != 200:
            raise ValueError(f'website returned HTTP {status}')
        if 'text/html' not in headers.get('content-type', '').lower():
            raise ValueError('URL does not return an HTML page')
        if len(body) > MAX_BYTES:
            raise ValueError('page is too large for the studio preview (200 KB limit)')
        charset = 'utf-8'
        match = re.search(r'charset=([\w-]+)', headers['content-type'], flags=re.I)
        if match:
            charset = match.group(1)
        try:
            source = body.decode(charset, errors='replace')
        except LookupError:
            raise ValueError('unsupported page encoding') from None
        return {'url': url, 'html': sanitize(source, url)}
    raise ValueError('too many redirects')
