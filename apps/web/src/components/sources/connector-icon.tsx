import { connectorInitials, iconTileStyle } from "@/lib/sources";

/**
 * A connector's icon (#306): its initials on a tile of its brand colour,
 * neutral without one. No bitmaps; decorative, the name sits next to it.
 */
export function ConnectorIcon({
  name,
  brandColor,
  size,
}: {
  name: string;
  brandColor: string | null;
  size: "small" | "large";
}) {
  return (
    <span
      className={`connector-icon connector-icon--${size}`}
      style={iconTileStyle(brandColor)}
      aria-hidden="true"
    >
      {connectorInitials(name)}
    </span>
  );
}
