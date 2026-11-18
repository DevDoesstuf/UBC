import type { Metadata, Viewport } from "next";
import "@fontsource-variable/geist/wght.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Huddle",
  description: "Call the next play with your friends. A tiny prediction market for your watch party.",
  applicationName: "Huddle",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
