const CACHE_NAME = "pro-meet-v2";

const STATIC_FILES = [
    "/",
    "/index.html"
];

// Install Service Worker
self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(STATIC_FILES))
            .then(() => self.skipWaiting())
    );
});

// Activate Service Worker
self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys
                    .filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch Handler
self.addEventListener("fetch", event => {

    const request = event.request;
    const url = new URL(request.url);

    // Only handle GET requests from this website
    if (
        request.method !== "GET" ||
        url.origin !== self.location.origin
    ) {
        return;
    }

    // Navigation: Network first
    if (request.mode === "navigate") {

        event.respondWith(
            fetch(request)
                .then(response => {
                    if (response.ok) {
                        const copy = response.clone();

                        caches.open(CACHE_NAME)
                            .then(cache => cache.put(
                                request,
                                copy
                            ));
                    }

                    return response;
                })
                .catch(async () => {

                    return await caches.match(request) ||
                           await caches.match("/") ||
                           await caches.match("/index.html");
                })
        );

        return;
    }

    // Static resources: Cache first
    if (
        url.pathname.endsWith(".css") ||
        url.pathname.endsWith(".js") ||
        url.pathname.endsWith(".png") ||
        url.pathname.endsWith(".jpg") ||
        url.pathname.endsWith(".svg") ||
        url.pathname.endsWith(".webp") ||
        url.pathname.endsWith(".woff2")
    ) {

        event.respondWith(
            caches.match(request).then(cached => {

                if (cached) {
                    return cached;
                }

                return fetch(request).then(response => {

                    if (response.ok) {
                        const copy = response.clone();

                        caches.open(CACHE_NAME)
                            .then(cache => cache.put(
                                request,
                                copy
                            ));
                    }

                    return response;
                });
            })
        );
    }

});
