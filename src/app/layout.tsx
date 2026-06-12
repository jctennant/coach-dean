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

const SEO_TITLE = "Coach Dean — AI Running Coach for Injury-Free Race Training";
const SEO_DESCRIPTION =
  "An AI running coach that connects to Strava and texts you after every run — flagging injury risk early and reworking your plan around shin splints, IT band pain, or time off, so you reach race day healthy.";

export const metadata: Metadata = {
  metadataBase: new URL("https://coachdean.ai"),
  title: SEO_TITLE,
  description: SEO_DESCRIPTION,
  applicationName: "Coach Dean",
  keywords: [
    "AI running coach",
    "running coach app",
    "injury prevention for runners",
    "return to running after injury",
    "running injury recovery",
    "marathon training plan",
    "half marathon training plan",
    "Strava running coach",
    "training through shin splints",
    "IT band recovery for runners",
    "stress fracture return to running",
    "personalized running plan",
  ],
  alternates: {
    canonical: "https://coachdean.ai",
  },
  robots: {
    index: true,
    follow: true,
  },
  icons: {
    icon: [
      { url: "/bubble-32.png", sizes: "32x32", type: "image/png" },
      { url: "/bubble-64.png", sizes: "64x64", type: "image/png" },
    ],
    apple: [{ url: "/bubble-64.png", sizes: "64x64", type: "image/png" }],
  },
  openGraph: {
    title: SEO_TITLE,
    description: SEO_DESCRIPTION,
    url: "https://coachdean.ai",
    siteName: "Coach Dean",
    type: "website",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Coach Dean — AI running coach" }],
  },
  twitter: {
    card: "summary_large_image",
    title: SEO_TITLE,
    description: SEO_DESCRIPTION,
    images: ["/og-image.png"],
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
