/**
 * Build plugins:
 *  - opencvVendor: ships the pinned OpenCV.js build as a static file
 *    (vendor/opencv-<version>.js), loaded lazily by the alignment worker.
 *  - serviceWorker: generates sw.js that precaches the app shell for offline
 *    use and "Add to Home Screen" (OpenCV is cached on first use instead).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);
const opencvPkg = require('@techstark/opencv-js/package.json') as { version: string };
export const OPENCV_FILE = `vendor/opencv-${opencvPkg.version}.js`;
const opencvPath = require.resolve('@techstark/opencv-js/dist/opencv.js');

export function opencvVendor(): Plugin {
  return {
    name: 'fm-opencv-vendor',
    config() {
      return { define: { __OPENCV_FILE__: JSON.stringify(OPENCV_FILE) } };
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.split('?')[0].endsWith(`/${OPENCV_FILE}`)) return next();
        res.setHeader('Content-Type', 'text/javascript');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.end(readFileSync(opencvPath));
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: OPENCV_FILE, source: readFileSync(opencvPath) });
    },
  };
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

export function serviceWorker(publicDir = 'public'): Plugin {
  return {
    name: 'fm-service-worker',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const built = Object.keys(bundle).filter((f) => !f.endsWith('.map') && !f.startsWith('vendor/') && f !== 'sw.js');
      let pub: string[] = [];
      try {
        pub = listFiles(publicDir).map((p) => relative(publicDir, p).split('\\').join('/'));
      } catch {
        /* no public dir */
      }
      const files = [...new Set([...built, ...pub])].filter((f) => f !== 'sw.js').sort();
      const version = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12);
      const precache = ['./', ...files.map((f) => `./${f}`)];
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: swSource(version, precache) });
    },
  };
}

function swSource(version: string, precache: string[]): string {
  return `// Generated at build time.
const CACHE = 'fm-shell-${version}';
const RUNTIME = 'fm-runtime';
const PRECACHE = ${JSON.stringify(precache)};

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('fm-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // Network first so updates arrive; the cached shell keeps the app working offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./', copy));
          return res;
        })
        .catch(() => caches.match('./', { ignoreSearch: true })),
    );
    return;
  }
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && /\\/(assets|vendor)\\//.test(url.pathname)) {
            const copy = res.clone();
            caches.open(RUNTIME).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
`;
}
