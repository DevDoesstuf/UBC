import type { Metadata, Viewport } from "next";

export const metadata: Metadata = { title: "Huddle · Watch" };
export const viewport: Viewport = { themeColor: "#0b0c0b", colorScheme: "dark" };

export default function WatchLayout({ children }: { children: React.ReactNode }) {
  return children;
}
