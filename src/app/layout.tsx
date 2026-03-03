import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { PostHogProvider } from "@/components/posthog-provider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://coachdean.ai"),
  title: "Coach Dean — AI Running Coach",
  description:
    "An AI-powered running coach that connects to Strava and coaches you via SMS.",
  icons: {
    icon: [
      { url: "/bubble-32.png", sizes: "32x32", type: "image/png" },
      { url: "/bubble-64.png", sizes: "64x64", type: "image/png" },
    ],
    apple: [{ url: "/bubble-64.png", sizes: "64x64", type: "image/png" }],
  },
  openGraph: {
    title: "Coach Dean — AI Running Coach",
    description:
      "An AI-powered running coach that connects to Strava and coaches you via SMS.",
    url: "https://coachdean.ai",
    siteName: "Coach Dean",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Coach Dean" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} antialiased`}
      >
        <PostHogProvider>{children}</PostHogProvider>
      </body>
    </html>
  );
}
