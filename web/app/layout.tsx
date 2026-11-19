import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import "@/components/huddle/huddle.css";

// Bundled fonts (no runtime CDN). Variable axes are declared so font-weight / font-stretch interpolate.
const head = localFont({
  src: "./fonts/bricolage-grotesque-latin.woff2",
  variable: "--font-head",
  weight: "200 800",
  display: "swap",
  declarations: [{ prop: "font-stretch", value: "75% 100%" }],
});
const num = localFont({
  src: "./fonts/archivo-latin-wdth.woff2",
  variable: "--font-num",
  weight: "100 900",
  display: "swap",
  declarations: [{ prop: "font-stretch", value: "62% 125%" }],
});
const body = localFont({
  src: "./fonts/atkinson-hyperlegible-next-latin.woff2",
  variable: "--font-body",
  weight: "200 800",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Huddle",
  description: "Call the next play with your friends. A tiny prediction market for your watch party.",
  applicationName: "Huddle",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#000000",
  colorScheme: "light",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${head.variable} ${num.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
