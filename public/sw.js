/*! streamsaver. MIT License. Jimmy Wärting <https://jimmy.warting.se/opensource> */

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim())
})

const map = new Map()

// This should be called once per download
// Each event has a dataChannel that the data will be piped through
self.onmessage = event => {
  // We send a heartbeat every x second to keep the
  // temporary file alive
  if (event.data === 'ping') {
    return
  }

  const data = event.data
  const downloadUrl = data.url || data.downloadUrl
  const port = event.ports[0]
  const metadata = new Array(3) // [stream, data, port]

  metadata[1] = data
  metadata[2] = port

  // Note to self:
  // old streamsaver v1.2.0 don't send a messageChannel
  if (port) {
    port.onmessage = evt => {
      // This is the transferable stream we receive from the main thread
      port.onmessage = null
      metadata[0] = evt.data.readableStream
      map.set(downloadUrl, metadata)
      port.postMessage({ download: downloadUrl })
    }
  }

  map.set(downloadUrl, metadata)
}

self.addEventListener('fetch', event => {
  const url = event.request.url

  // this only works for Firefox
  if (url.endsWith('/ping')) {
    event.respondWith(new Response('pong'))
    return
  }

  // Blob URL은 가로채지 않음
  if (url.startsWith('blob:')) {
    return
  }

  const metadata = map.get(url)

  // StreamSaver URL이 아니면 무시 (기본 fetch 동작)
  if (!metadata) {
    return
  }

  const [ stream, data, port ] = metadata

  map.delete(url)

  // Not comfortable letting any user control all headers
  // so we only copy over the length & disposition
  const responseHeaders = new Headers({
    'Content-Type': 'application/octet-stream; charset=utf-8',

    // To be on the safe side, The link can be opened in a iframe.
    // but octet-stream should stop it.
    'Content-Security-Policy': "default-src 'none'",
    'X-Content-Security-Policy': "default-src 'none'",
    'X-WebKit-CSP': "default-src 'none'",
    'X-XSS-Protection': '1; mode=block'
  })

  let headers = new Headers(data.headers || {})

  if (headers.has('Content-Length')) {
    responseHeaders.set('Content-Length', headers.get('Content-Length'))
  }

  if (headers.has('Content-Disposition')) {
    responseHeaders.set('Content-Disposition', headers.get('Content-Disposition'))
  }

  // data, data.filename and size should not be used anymore
  if (data.size) {
    console.warn('Deprecated')
    responseHeaders.set('Content-Length', data.size)
  }

  let fileName = typeof data.filename === 'string' && data.filename
  if (fileName) {
    console.warn('Deprecated')
    // Make filename RFC5987 compatible
    fileName = encodeURIComponent(fileName).replace(/['()]/g, encodeURIComponent).replace(/\*/g, '%2A')
    responseHeaders.set('Content-Disposition', "attachment; filename*=UTF-8''" + fileName)
  }

  event.respondWith(new Response(stream, { headers: responseHeaders }))

  port && port.postMessage({ debug: 'Download started' })
})
