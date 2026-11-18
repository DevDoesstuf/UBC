import type { Metadata, Viewport } from "next";
import "./kiosk.css";

export const metadata: Metadata = { title: "Huddle · Box" };
export const viewport: Viewport = { themeColor: "#10261C", colorScheme: "light" };

export default function KioskLayout({ children }: { children: React.ReactNode }) {
  return children;
}
