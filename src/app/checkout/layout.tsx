import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Start your free trial — Coach Dean",
  description: "7-day free trial. Cancel anytime before it ends and you won't pay a thing.",
  openGraph: {
    title: "Start your free trial — Coach Dean",
    description: "7-day free trial. No charge until the trial ends.",
  },
};

export default function CheckoutLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
