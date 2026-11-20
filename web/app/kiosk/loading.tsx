import { BrandLoader } from "@/components/huddle";

// The box preview while it loads (then KioskConnecting draws the box's own connection page).
export default function Loading() {
  return (
    <div className="hd-loader-page">
      <BrandLoader label="Waking up the box…" />
    </div>
  );
}
