import { BrandLoader } from "@/components/huddle";

// The TV page while it loads: same look as its own "Getting the game on screen" state.
export default function Loading() {
  return (
    <div className="tvk tvk-state">
      <BrandLoader size="lg" className="tvk-state-body" label="Getting the game on screen" />
    </div>
  );
}
