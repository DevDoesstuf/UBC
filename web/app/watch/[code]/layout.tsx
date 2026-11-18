import type { Metadata, Viewport } from "next";
import "@/components/tv/tv.css";

export const metadata: Metadata = { title: "Huddle · Watch" };
export const viewport: Viewport = { themeColor: "#F6F3EA", colorScheme: "light" };

export default function WatchLayout({ children }: { children: React.ReactNode }) {
  return children;
}
