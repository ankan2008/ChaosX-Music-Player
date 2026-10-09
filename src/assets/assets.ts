import defaultAlbumArt from './default-album.svg';

export const DEFAULT_ALBUM_ART = defaultAlbumArt;

// Bundled icon URLs (hashed by Vite so they resolve under file:// in production)
const iconModules = import.meta.glob('./icons/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

export const ICON_URLS: Record<string, string> = Object.fromEntries(
  Object.entries(iconModules).map(([file, url]) => [
    file.replace('./icons/', '').replace('.png', ''),
    url,
  ]),
);
