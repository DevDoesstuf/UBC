import type { Metadata, Viewport } from "next";

export const metadata: Metadata = { title: "Huddle · Kiosk" };
export const viewport: Viewport = { themeColor: "#000000", colorScheme: "dark" };

export default function KioskLayout({ children }: { children: React.ReactNode }) {
  return children;
}
