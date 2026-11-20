import { BrandLoader } from "@/components/huddle";

// Shown while a page loads: the mark turning with "huddle" under it.
export default function Loading() {
  return (
    <div className="hd-loader-page">
      <BrandLoader />
    </div>
  );
}
