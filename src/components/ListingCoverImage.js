import React from 'react';
import SmartImage from './SmartImage';

/**
 * ListingCoverImage — thin wrapper around the new SmartImage so older callers
 * (Home cards, chat list thumbnails, etc.) inherit the nuclear behaviour:
 *   - hard fallback URL on error
 *   - no infinite spinner
 *   - aggressive console.log of the URI being rendered
 *
 * NOTE: Kept as a named export AND default export to avoid breaking either
 * `import { ListingCoverImage }` or `import ListingCoverImage` callsites.
 */
export function ListingCoverImage({ uri, style, recycleKey }) {
  return <SmartImage uri={uri} style={style} recycleKey={recycleKey} resizeMode="cover" />;
}

export default ListingCoverImage;
