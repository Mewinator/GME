
const DB_NAME = 'GME_Projects';
const MARKER = '/__gme__/';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));


const MIME = {
    html: 'text/html', htm: 'text/html',
    js: 'application/javascript', mjs: 'application/javascript',
    css: 'text/css',
    json: 'application/json',
    wasm: 'application/wasm',
    data: 'application/octet-stream',
    mem: 'application/octet-stream',
    unityweb: 'application/octet-stream',
    bundle: 'application/octet-stream',
    bin: 'application/octet-stream',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon', bmp: 'image/bmp',
    mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
    ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
    txt: 'text/plain', md: 'text/markdown', xml: 'application/xml',
    csv: 'text/csv', pdf: 'application/pdf'
};

function extensionOf(path) {
    const base = path.split('/').pop() || '';
    const dot = base.lastIndexOf('.');
    return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

function describe(path) {
    let ext = extensionOf(path);
    let encoding = null;
    if (ext === 'gz' || ext === 'br') {
        encoding = ext === 'gz' ? 'gzip' : 'br';
        ext = extensionOf(path.slice(0, -(ext.length + 1)));
    }
    return { type: MIME[ext] || 'application/octet-stream', encoding };
}


function canDecompress(encoding) {
    if (typeof DecompressionStream === 'undefined') return false;
    try {
        new DecompressionStream(encoding);
        return true;
    } catch (_) {
        return false;
    }
}

async function decompress(blob, encoding) {
    const stream = blob.stream().pipeThrough(new DecompressionStream(encoding));
    return await new Response(stream).blob();
}


function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
}

function fileKey(project, path) {
    return project + '\u0000' + path;
}

function getFile(db, project, path) {
    return new Promise((resolve) => {
        if (!db.objectStoreNames.contains('files')) return resolve(null);
        const request = db.transaction('files').objectStore('files').get(fileKey(project, path));
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => resolve(null);
    });
}


function textResponse(status, message) {
    return new Response(message, {
        status,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
}

function rangeResponse(blob, type, rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match) return null;

    const size = blob.size;
    let start;
    let end;

    if (match[1] === '') {
        const suffix = parseInt(match[2], 10);
        if (isNaN(suffix)) return null;
        start = Math.max(0, size - suffix);
        end = size - 1;
    } else {
        start = parseInt(match[1], 10);
        end = match[2] === '' ? size - 1 : parseInt(match[2], 10);
    }

    if (isNaN(start) || isNaN(end) || start > end || start >= size) {
        return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${size}` }
        });
    }
    end = Math.min(end, size - 1);

    return new Response(blob.slice(start, end + 1), {
        status: 206,
        headers: {
            'Content-Type': type,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store'
        }
    });
}

async function serve(request, virtualPath) {
    const slash = virtualPath.indexOf('/');
    if (slash === -1) return textResponse(400, 'GME: malformed virtual path.');

    const project = decodeURIComponent(virtualPath.slice(0, slash));
    let path = virtualPath
        .slice(slash + 1)
        .split('/')
        .map(decodeURIComponent)
        .join('/');

    if (path === '' || path.endsWith('/')) path += 'index.html';

    let db;
    try {
        db = await openDb();
    } catch (err) {
        return textResponse(500, 'GME: could not open the project database.\n' + err);
    }

    let record = await getFile(db, project, path);

    if (!record && path.startsWith(project + '/')) {
        record = await getFile(db, project, path.slice(project.length + 1));
    }

    if (!record) {
        return textResponse(404, `GME: "${path}" is not in project "${project}".`);
    }

    const { type, encoding } = describe(path);
    let blob = record.data instanceof Blob ? record.data : new Blob([record.data], { type });

    if (record.enc) {
        if (!canDecompress(record.enc)) {
            return textResponse(
                501,
                `GME: "${path}" was stored ${record.enc}-compressed and this browser ` +
                'cannot decompress it. Re-upload the project with compression turned off.'
            );
        }
        try {
            blob = await decompress(blob, record.enc);
        } catch (err) {
            return textResponse(500, `GME: failed to unpack stored file "${path}".\n` + err);
        }
    }

    if (encoding) {
        if (!canDecompress(encoding)) {
            return textResponse(
                501,
                `GME: this build ships ${encoding.toUpperCase()}-compressed files ("${path}") ` +
                `and this browser cannot decompress ${encoding} in a service worker.\n\n` +
                'Fix: in Unity, set Player Settings > Publishing Settings > Compression Format ' +
                'to "Gzip" or "Disabled", then rebuild and re-upload.'
            );
        }
        try {
            blob = await decompress(blob, encoding);
        } catch (err) {
            return textResponse(500, `GME: failed to decompress "${path}".\n` + err);
        }
    }

    const range = request.headers.get('Range');
    if (range) {
        const partial = rangeResponse(blob, type, range);
        if (partial) return partial;
    }

    return new Response(blob, {
        status: 200,
        headers: {
            'Content-Type': type,
            'Content-Length': String(blob.size),
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store'
        }
    });
}

function projectOf(rawUrl) {
    if (!rawUrl) return null;
    let pathname;
    try {
        pathname = new URL(rawUrl, self.location.href).pathname;
    } catch (_) {
        return null;
    }
    const index = pathname.indexOf(MARKER);
    if (index === -1) return null;
    const rest = pathname.slice(index + MARKER.length);
    const slash = rest.indexOf('/');
    return slash === -1 ? rest : rest.slice(0, slash);
}

const failsafe = (err) => textResponse(500, 'GME: virtual filesystem error.\n' + err);

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;

    const index = url.pathname.indexOf(MARKER);
    if (index !== -1) {
        event.respondWith(
            serve(event.request, url.pathname.slice(index + MARKER.length)).catch(failsafe)
        );
        return;
    }

    const referrerOwner = projectOf(event.request.referrer);
    if (referrerOwner) {
        event.respondWith(serve(event.request, referrerOwner + url.pathname).catch(failsafe));
        return;
    }

    if (!event.clientId) return;

    event.respondWith((async () => {
        let owner = null;
        try {
            const client = await self.clients.get(event.clientId);
            owner = client && projectOf(client.url);
        } catch (_) {  }

        if (!owner) return fetch(event.request);
        return serve(event.request, owner + url.pathname).catch(failsafe);
    })());
});
