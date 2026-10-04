/** Side of the thumbnail the dominant colour is read from. */
const SAMPLE_SIDE = 64;

/**
 * The RGBA pixels of a workspace image, scaled down to 64 × 64 (browser
 * only). The image comes from the API's own origin, so the canvas is not
 * tainted. Null when the browser cannot decode or read it.
 */
export async function readIconPixels(
  url: string,
): Promise<Uint8ClampedArray | null> {
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_SIDE;
    canvas.height = SAMPLE_SIDE;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, SAMPLE_SIDE, SAMPLE_SIDE);
    return context.getImageData(0, 0, SAMPLE_SIDE, SAMPLE_SIDE).data;
  } catch {
    return null;
  }
}
