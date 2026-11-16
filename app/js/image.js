// Pictures for AI help: snips are scaled down and sent as JPEG, which keeps
// them well inside Groq's size limit and quick to upload.

export const MAX_SIDE = 1568;

/** Part of `source` (an image or canvas), scaled to fit `max`, as a JPEG data URL. */
export function toJpeg(source, sx, sy, sw, sh, max = MAX_SIDE, quality = 0.86) {
  const k = Math.min(1, max / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * k));
  c.height = Math.max(1, Math.round(sh * k));
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

/** A picture (data URL) scaled to fit `max`, as a JPEG data URL. */
export async function fitImage(src, max = MAX_SIDE) {
  const img = new Image();
  img.src = src;
  await img.decode();
  return toJpeg(img, 0, 0, img.naturalWidth, img.naturalHeight, max);
}
