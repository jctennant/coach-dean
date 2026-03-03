import { Suspense } from "react";
import { SignupForm } from "@/components/signup-form";
import { IMessageMockup } from "@/components/imessage-mockup";
import { Navbar } from "@/components/navbar";
import { RaceMarquee } from "@/components/race-marquee";

/* ------------------------------------------------------------------ */
/*  Value prop sections (alternating layout)                           */
/* ------------------------------------------------------------------ */

const valueProps = [
  {
    title: "A personalized plan in minutes",
    description:
      "Answer a few questions over text and Dean builds a training plan tailored to your goal, schedule, and fitness level — ready to go before you put your phone down.",
    screenshot: "/screenshot-1.png",
  },
  {
    title: "Smart adjustments for injury prevention",
    description:
      "Dean tracks how your body responds over time. Mention a nagging pain or flagging energy and he'll pull back your volume, adjust intensity, and keep you training rather than sidelined.",
    screenshot: "/screenshot-2.png",
  },
  {
    title: "Ask anything, any time",
    description:
      "Nutrition, race strategy, taper, cross-training — text Dean like you'd text a coach who actually knows your history. He gives you specific answers, not generic advice.",
    screenshot: "/screenshot-3.png",
  },
];

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function Home() {
  const smsPhone = process.env.LINQ_PHONE_NUMBER ?? "+18336373002";
  const smsUrl = `sms:${smsPhone}&body=Hi%20Dean!`;
  return (
    <div className="flex min-h-screen flex-col" style={{ minHeight: "100vh" }}>
      <Navbar smsUrl={smsUrl} />

      {/* Hero */}
      <section id="get-started" className="flex items-center px-6" style={{ minHeight: "100vh", paddingTop: "calc(4rem + 48px)", paddingBottom: "48px" }}>
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-12 md:flex-row md:items-center md:gap-16">
          {/* Text + form */}
          <div className="flex flex-1 flex-col items-center gap-6 text-center md:items-start md:text-left" style={{ maxWidth: 480 }}>
            <h1 className="font-serif text-4xl font-normal leading-tight tracking-tight md:text-5xl lg:text-5xl">
              Personalized coaching, just a text away.
            </h1>
            <p className="text-lg" style={{ color: "#4a4a4a" }}>
              Dean tracks your training and injury history, learns how your body responds,
              and texts you exactly what to do next — so you arrive at the start line healthy and ready for a new PR.
            </p>
            <Suspense>
              <SignupForm smsPhone={smsPhone} />
            </Suspense>
          </div>
          {/* iPhone mockup */}
          <div className="flex flex-1 justify-center">
            <IMessageMockup />
          </div>
        </div>
      </section>

      <RaceMarquee />

      {/* Value props — alternating layout */}
      {valueProps.map((prop, i) => {
        const reversed = i % 2 === 1;
        return (
          <section
            key={i}
            className={`border-t px-6 py-16 md:py-24 ${i % 2 === 0 ? "bg-muted/40" : ""}`}
          >
            <div
              className={`mx-auto flex max-w-5xl flex-col items-center gap-12 md:flex-row md:gap-16 ${
                reversed ? "md:flex-row-reverse" : ""
              }`}
            >
              {/* Text */}
              <div className="flex-1 text-center md:text-left">
                <h2 className="mb-4 font-serif text-2xl font-normal md:text-3xl">
                  {prop.title}
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  {prop.description}
                </p>
              </div>
              {/* Screenshot */}
              <div className="flex-1 flex justify-center">
                <img
                  src={prop.screenshot}
                  alt={prop.title}
                  className="w-full object-contain"
                  style={{ maxWidth: "min(380px, 100%)", maxHeight: 520 }}
                />
              </div>
            </div>
          </section>
        );
      })}

      {/* FAQ */}
      <section className="border-t px-6 py-16 md:py-24">
        <div className="mx-auto max-w-2xl">
          <h2 className="mb-10 text-center font-serif text-2xl font-normal md:text-3xl">
            Frequently asked questions
          </h2>
          <div className="divide-y">
            {[
              {
                q: "How is Coach Dean different from Runna or using ChatGPT to plan my workouts?",
                a: (
                  <>
                    <p>Runna gives you a great static plan, but it doesn't know that you had a rough week, skipped two workouts, or ran your long run way too fast. Coach Dean lives in your text messages and adapts in real time — just reply with how a workout went and he'll adjust.</p>
                    <p className="mt-3">ChatGPT can answer running questions, but it has no memory of your training history, no structured plan, and no one checking in on you. Dean combines the personalization of a real coach with the convenience of SMS — no app to open, no dashboard to check in on.</p>
                  </>
                ),
              }, 
              {
                q: "What type of races can Coach Dean help me prepare for?",
                a: "Coach Dean can build training plans for 5Ks all the way up to ultramarathons, including half marathons, full marathons, and trail races. If you're training for a triathlon, he can factor in your swimming and cycling alongside your run training. Not sure what distance is right for you? Tell Dean where you're at and he'll help you figure it out.",
              },
              {
                q: "How does Coach Dean know what paces to assign my workouts?",
                a: "During onboarding, Dean asks for your recent race times or your comfortable conversational pace. From there he uses established training pace formulas to calculate your personal zones — easy, tempo, threshold, and interval — and builds every workout around those numbers. As you train and share feedback, Dean refines those paces over time. No guesswork, no one-size-fits-all pace charts.",
              },
              {
                q: "Do I need a GPS watch or Strava to use Coach Dean?",
                a: "Nope. All you need is a phone number. Coach Dean works entirely over SMS — no app to download, no account to create, no device required.",
              },
              {
                q: "How much does Coach Dean cost?",
                a: "Coach Dean is currently free during beta. We're focused on building something genuinely useful before charging for it. When pricing is introduced, early beta users will be the first to know — and we plan to take care of the people who believed in Dean early.",
              },
              {
                q: "What happens if I miss a workout or need to take a week off?",
                a: "Just tell Dean. Seriously — text him like you'd text a coach. Whether you missed a run, got sick, or needed a mental break, Dean will adjust your upcoming week to account for it and keep you on track toward your goal. Life happens, and a good coach works around it rather than ignoring it.",
              },
              {
                q: "Is my data private?",
                a: "Your training data, pace information, and conversations with Dean are used solely to power your coaching experience — nothing else. We don't sell your data or share it with third parties. If you connect Strava, that access is read-only and only used to pull your workout history into Dean. You can request deletion of your data at any time by texting Dean or emailing jake.c.tennant@gmail.com.",
              },
            ].map(({ q, a }) => (
              <details key={q} className="group py-4">
                <summary className="flex cursor-pointer list-none items-start justify-between gap-4 font-medium">
                  <span>{q}</span>
                  <span className="mt-0.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-45">
                    +
                  </span>
                </summary>
                <div className="mt-3 text-sm leading-relaxed text-muted-foreground">{a}</div>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="flex flex-col items-center gap-6 border-t bg-muted/40 px-6 py-16 text-center md:py-24">
        <h2 className="max-w-xl font-serif text-2xl font-normal md:text-3xl">
          Ready to run smarter?
        </h2>
        <Suspense>
          <SignupForm smsPhone={smsPhone} centered />
        </Suspense>
      </section>

      {/* Footer */}
      <footer className="border-t px-6 py-10 text-center text-sm text-muted-foreground">
        <div className="mx-auto flex max-w-2xl flex-col items-center gap-3">
          <p className="font-medium text-foreground">CoachDean</p>
          <p>
            Questions or feedback?{" "}
            <a
              href="mailto:jake.c.tennant@gmail.com"
              className="underline hover:text-foreground"
            >
              jake.c.tennant@gmail.com
            </a>
          </p>
          <div className="flex gap-4 text-xs">
            <a href="/privacy" className="underline hover:text-foreground">Privacy Policy</a>
            <a href="/terms" className="underline hover:text-foreground">Terms of Service</a>
          </div>
          <p className="text-xs text-muted-foreground/70">
            &copy; {new Date().getFullYear()} CoachDean. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
