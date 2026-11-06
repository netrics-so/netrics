/** Side of the thumbnail the dominant colour is read from. */
export const SAMPLE_SIDE = 64;

/** How long reading an icon may take before the theme accent is used. */
export const READ_TIMEOUT_MS = 8000;

/** What reading pixels needs from the browser; replaced in tests. */
export interface PixelReader {
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  /** RGBA pixels of an encoded image, scaled to `side` × `side`. */
  decode: (blob: Blob, side: number) => Promise<Uint8ClampedArray | null>;
}

/**
 * Decodes off the DOM: `createImageBitmap` settles in a background tab,
 * whereas `HTMLImageElement.decode()` waits for the page to render a frame
 * and never settles while it does not (#248).
 */
async function decodeInBrowser(
  blob: Blob,
  side: number,
): Promise<Uint8ClampedArray | null> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, side, side);
    return context.getImageData(0, 0, side, side).data;
  } finally {
    bitmap.close();
  }
}

const browserReader: PixelReader = {
  fetch: (url, init) => fetch(url, init),
  decode: decodeInBrowser,
};

/**
 * The RGBA pixels of a workspace image, scaled down to 64 × 64. The image
 * comes from the API's own origin, so reading it is allowed. Always
 * settles: null when the image cannot be fetched or decoded, or after
 * `timeoutMs`.
 */
export async function readIconPixels(
  url: string,
  reader: PixelReader = browserReader,
  timeoutMs: number = READ_TIMEOUT_MS,
): Promise<Uint8ClampedArray | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  const read = (async () => {
    const response = await reader.fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return reader.decode(await response.blob(), SAMPLE_SIDE);
  })().catch(() => null);
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
