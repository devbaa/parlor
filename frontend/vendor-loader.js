const ORT_SRC = '/vendor/onnxruntime-web/ort.min.js';
const VAD_SRC = '/vendor/vad-web/bundle.min.js';

const loadedScripts = new Map();

function loadScript(src) {
  if (loadedScripts.has(src)) return loadedScripts.get(src);

  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve(src);
    script.onerror = () => reject(new Error(`Failed to load required local dependency: ${src}`));
    document.head.appendChild(script);
  });

  loadedScripts.set(src, promise);
  return promise;
}

export async function ensureVendorScripts() {
  await Promise.all([
    loadScript(ORT_SRC),
    loadScript(VAD_SRC),
  ]);
}
