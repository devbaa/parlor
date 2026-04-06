const ORT_SRC = '/vendor/onnxruntime-web/ort.min.js';
const ORT_FALLBACK = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.min.js';
const VAD_SRC = '/vendor/vad-web/bundle.min.js';
const VAD_FALLBACK = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/bundle.min.js';

const loadedScripts = new Map();

function loadScript(src, fallback) {
  if (loadedScripts.has(src)) return loadedScripts.get(src);

  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve(src);
    script.onerror = () => {
      if (!fallback) {
        reject(new Error(`Failed to load ${src}`));
        return;
      }

      const fallbackScript = document.createElement('script');
      fallbackScript.src = fallback;
      fallbackScript.onload = () => resolve(fallback);
      fallbackScript.onerror = () => reject(new Error(`Failed to load ${src} and fallback`));
      document.head.appendChild(fallbackScript);
    };
    document.head.appendChild(script);
  });

  loadedScripts.set(src, promise);
  return promise;
}

export async function ensureVendorScripts() {
  await Promise.all([
    loadScript(ORT_SRC, ORT_FALLBACK),
    loadScript(VAD_SRC, VAD_FALLBACK),
  ]);
}
