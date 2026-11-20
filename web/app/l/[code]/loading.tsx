import { BrandLoader } from "@/components/huddle";

// The phone page while it loads (the page itself then says "Finding party ABCD…" with the same loader).
export default function Loading() {
  return (
    <div className="hd-loader-page">
      <BrandLoader label="Finding your party…" />
    </div>
  );
}
