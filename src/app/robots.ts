import type { MetadataRoute } from "next";

const BASE_URL = "https://coachdean.ai";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Keep authenticated/transactional surfaces out of the index
      disallow: ["/api/", "/dashboard", "/checkout", "/cancel"],
    },
    sitemap: `${BASE_URL}/sitemap.xml`,
    host: BASE_URL,
  };
}
