/**
 * Enriched media of a public catalogue entry, from native Frappe data only:
 * the Item `image` and the File documents attached to the Item. A File is either
 * an uploaded public file (/files/...) or an external link (https://...), which
 * is how a video or a virtual tour hosted elsewhere is attached.
 *
 * Private files never leave the server: a File must be is_private = 0 and its URL
 * must be a public /files/ path or an external https link. /private/ paths and
 * Frappe download methods are rejected even if a File row says otherwise.
 */

export type MediaKind = 'IMAGE' | 'VIDEO' | 'VIRTUAL_TOUR';
export type MediaSource = 'FRAPPE_FILE' | 'EXTERNAL_LINK';
export interface MediaAsset {
  id: string;
  kind: MediaKind;
  source: MediaSource;
  url: string;
  mimeType: string | null;
  provider: string | null;
  isCover: boolean;
}

export interface FileRow {
  name: string;
  file_url: string | null;
  is_private: number | string | null;
  attached_to_name: string | null;
  creation?: string | null;
}

const IMAGE_TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
const VIDEO_TYPES: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime' };
const VIDEO_HOSTS: Record<string, string> = { 'youtube.com': 'youtube', 'youtu.be': 'youtube', 'youtube-nocookie.com': 'youtube', 'vimeo.com': 'vimeo', 'dailymotion.com': 'dailymotion' };
export const VIRTUAL_TOUR_HOSTS = ['matterport.com', 'kuula.co', 'momento360.com', 'roundme.com', '360cities.net'];

const onHost = (hostname: string, domain: string) => hostname === domain || hostname.endsWith('.' + domain);
const extension = (pathname: string) => /\.([a-z0-9]{2,5})$/.exec(pathname.toLowerCase())?.[1] ?? '';

/** The browser-safe URL of a File URL, or null when it is not public. */
export function publicMediaUrl(fileUrl: string | null | undefined, siteHost: string): { url: URL; source: MediaSource } | null {
  const raw = String(fileUrl ?? '').trim();
  if (!raw || raw.length > 2000) return null;
  if (raw.startsWith('/')) {
    // Only the public files directory of the site; no traversal, query or fragment.
    if (!/^\/files\/[^?#\\]+$/.test(raw) || raw.split('/').some(part => part === '..' || part === '.')) return null;
    try { return { url: new URL(raw, `https://${siteHost}`), source: 'FRAPPE_FILE' }; } catch { return null; }
  }
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  // An absolute link back to the ERP must still be a public file.
  if (url.hostname === siteHost && !/^\/files\/[^?#]+$/.test(url.pathname)) return null;
  return { url, source: url.hostname === siteHost ? 'FRAPPE_FILE' : 'EXTERNAL_LINK' };
}

function classify(url: URL, tourHosts: string[]): Pick<MediaAsset, 'kind' | 'mimeType' | 'provider'> | null {
  const host = url.hostname.toLowerCase();
  const tour = tourHosts.find(domain => onHost(host, domain));
  if (tour) return { kind: 'VIRTUAL_TOUR', mimeType: null, provider: tour };
  const video = Object.keys(VIDEO_HOSTS).find(domain => onHost(host, domain));
  if (video) return { kind: 'VIDEO', mimeType: null, provider: VIDEO_HOSTS[video] };
  const ext = extension(url.pathname);
  if (IMAGE_TYPES[ext]) return { kind: 'IMAGE', mimeType: IMAGE_TYPES[ext], provider: null };
  if (VIDEO_TYPES[ext]) return { kind: 'VIDEO', mimeType: VIDEO_TYPES[ext], provider: null };
  return null;
}

/**
 * Media of one Item: its `image` first (the cover), then its public attached
 * Files by creation date. Unknown types (PDF, office files) are not media.
 */
export function itemMedia(image: string | null | undefined, files: FileRow[], siteHost: string, extraTourHosts: string[] = []): MediaAsset[] {
  const tourHosts = [...VIRTUAL_TOUR_HOSTS, ...extraTourHosts];
  const assets: MediaAsset[] = [];
  const seen = new Set<string>();
  const add = (id: string, fileUrl: string | null | undefined, cover: boolean) => {
    const resolved = publicMediaUrl(fileUrl, siteHost);
    if (!resolved) return;
    const kind = classify(resolved.url, tourHosts);
    const href = resolved.url.href;
    if (!kind || seen.has(href) || (cover && kind.kind !== 'IMAGE')) return;
    seen.add(href);
    assets.push({ id, source: resolved.source, url: href, ...kind, isCover: cover });
  };
  const publicFiles = files
    .filter(file => Number(file.is_private) === 0)
    .sort((a, b) => String(a.creation ?? '').localeCompare(String(b.creation ?? '')) || a.name.localeCompare(b.name));
  // The cover keeps the id of its File when there is one; a /private/ image is rejected by publicMediaUrl.
  if (image) add(publicFiles.find(file => file.file_url === image)?.name ?? 'item-image', image, true);
  for (const file of publicFiles) add(file.name, file.file_url, false);
  if (!assets.some(asset => asset.isCover)) {
    const firstImage = assets.find(asset => asset.kind === 'IMAGE');
    if (firstImage) firstImage.isCover = true;
  }
  return assets;
}
