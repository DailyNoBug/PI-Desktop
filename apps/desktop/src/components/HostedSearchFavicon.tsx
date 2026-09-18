import { useMemo, useState } from "react";
import { hostedSearchFaviconCandidates } from "../lib/hosted-search-ui";

export function HostedSearchFavicon({
  url,
  size = 14,
}: {
  url: string;
  size?: number;
}) {
  const candidates = useMemo(() => hostedSearchFaviconCandidates(url), [url]);
  const [index, setIndex] = useState(0);
  const src = candidates[index];
  if (!src) {
    return (
      <span
        className="hosted-search-favicon hosted-search-favicon-fallback"
        style={{ width: size, height: size }}
        aria-hidden
      />
    );
  }
  return (
    <img
      alt=""
      aria-hidden="true"
      className="hosted-search-favicon"
      decoding="async"
      loading="lazy"
      referrerPolicy="no-referrer"
      src={src}
      width={size}
      height={size}
      onError={() => setIndex((current) => current + 1)}
    />
  );
}
