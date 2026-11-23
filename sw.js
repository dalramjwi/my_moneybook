// [가계부앱] 2026-11-20 : 오프라인용 캐시. 온라인이면 새 파일을 받고, 안 되면 저장해 둔 파일로 연다
// [가계부앱] 2026-11-23 : 설치할 때 앱 파일을 미리 받아 둔다 (첫 방문 직후에도 오프라인으로 열리고, 나중에 불러오는 엑셀 라이브러리도 오프라인에서 쓸 수 있게)
const FILES = ['./', 'index.html', 'style.css', 'core.js', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'vendor/xlsx.full.min.js', 'vendor/RIDIBatang.woff'];
self.addEventListener('install', e => {
  self.skipWaiting(); // 새 버전을 기다리지 않고 바로 적용
  e.waitUntil(caches.open('app').then(c => c.addAll(FILES.map(u => new Request(u, { cache: 'no-cache' })))));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    // [가계부앱] 2026-11-23 : 브라우저 캐시에 남은 옛 파일이 새 파일과 섞이지 않게, 받을 때마다 서버에 최신인지 확인한다
    fetch(e.request, { cache: 'no-cache' })
      .then(res => { const copy = res.clone(); caches.open('app').then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
