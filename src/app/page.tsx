import { Suspense } from "react";
import { SignupForm } from "@/components/signup-form";
import { IMessageMockup } from "@/components/imessage-mockup";
import { Navbar } from "@/components/navbar";
import { RaceMarquee } from "@/components/race-marquee";

/* ------------------------------------------------------------------ */
/*  Insight card — static iMessage snippet                             */
/* ------------------------------------------------------------------ */

const SYS_FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";

function InsightCard({
  context,
  tag,
  tagColor,
  messages,
}: {
  context: string;
  tag: string;
  tagColor: string;
  messages: Array<{ from: "dean" | "user"; text: string }>;
}) {
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      {/* iMessage header */}
      <div
        style={{
          background: "#f2f2f7",
          borderBottom: "1px solid rgba(0,0,0,0.10)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 14px",
        }}
      >
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: "50%",
            background: "#1a5c35",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontFamily: SYS_FONT,
              fontSize: 11,
              fontWeight: 600,
              color: "#ffffff",
              letterSpacing: 0.4,
              lineHeight: 1,
            }}
          >
            CD
          </span>
        </div>
        <div>
          <p
            style={{
              fontFamily: SYS_FONT,
              fontSize: 13,
              fontWeight: 600,
              color: "#000",
              margin: 0,
              lineHeight: 1.2,
            }}
          >
            Coach Dean
          </p>
          <p
            style={{
              fontFamily: SYS_FONT,
              fontSize: 11,
              color: "#8e8e93",
              margin: 0,
              lineHeight: 1.2,
            }}
          >
            {context}
          </p>
        </div>
      </div>

      {/* Bubbles */}
      <div
        style={{
          padding: "14px 14px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          flex: 1,
        }}
      >
        {messages.map((msg, i) => {
          const isUser = msg.from === "user";
          return (
            <div
              key={i}
              style={{
                display: "flex",
                justifyContent: isUser ? "flex-end" : "flex-start",
              }}
            >
              <p
                style={{
                  maxWidth: "85%",
                  margin: 0,
                  padding: "9px 13px",
                  borderRadius: 18,
                  fontFamily: SYS_FONT,
                  fontSize: 14,
                  fontWeight: 400,
                  lineHeight: 1.45,
                  background: isUser ? "#0B84FE" : "#e9e9eb",
                  color: isUser ? "#ffffff" : "#000000",
                  wordBreak: "break-word",
                }}
              >
                {msg.text}
              </p>
            </div>
          );
        })}
      </div>

      {/* Tag */}
      <div
        style={{
          borderTop: "1px solid rgba(0,0,0,0.06)",
          padding: "8px 14px",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: tagColor,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontFamily: SYS_FONT,
            fontSize: 11,
            fontWeight: 500,
            color: "#8e8e93",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          {tag}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function Home() {
  const smsPhone = process.env.LINQ_PHONE_NUMBER ?? "+18336373002";
  const smsUrl = `sms:${smsPhone}?body=Hi Coach Dean!`;
  return (
    <div className="flex min-h-screen flex-col" style={{ minHeight: "100vh" }}>
      <Navbar smsUrl={smsUrl} />

      {/* Hero */}
      <section id="get-started" className="flex items-center px-6" style={{ minHeight: "100vh", paddingTop: "calc(4rem + 48px)", paddingBottom: "48px" }}>
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-12 md:flex-row md:items-center md:gap-16">
          {/* Text + form */}
          <div className="flex flex-1 flex-col items-center gap-6 text-center md:items-start md:text-left" style={{ maxWidth: 480 }}>
            <h1 className="font-serif text-4xl font-normal leading-tight tracking-tight md:text-5xl lg:text-5xl">
              An expert running coach designed to keep you healthy.
            </h1>
            <p className="text-lg" style={{ color: "#4a4a4a" }}>
              Most runners don&apos;t quit. They get hurt. Coach Dean monitors your load, flags warning signs before they become injuries, and adapts your training when something flares up. All over text.
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

      {/* How it works — 3 steps */}
      <section className="border-t px-6 py-14 md:py-20">
        <div className="mx-auto max-w-4xl">
          <h2 className="mb-10 text-center font-serif text-2xl font-normal md:text-3xl">
            How it works
          </h2>

          <div className="grid gap-4 md:grid-cols-3 md:gap-6">
            {[
              { step: "01", label: "Connect Strava", sub: "One tap. Coach Dean reads your full history and builds your load and injury risk profile from day one." },
              { step: "02", label: "Dean watches every run for warning signs", sub: "Coaching note within minutes. Load spikes, grey-zone effort, form cues. Dean flags what matters before it becomes a problem. Mention a sore knee or missed run and your plan adjusts." },
              { step: "03", label: "Train through the whole season", sub: "Not in cycles of training hard, getting hurt, and starting over. Stay consistent, stay healthy, and actually reach your goal." },
            ].map(({ step, label, sub }) => (
              <div key={step} className="flex flex-col gap-4 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                <span
                  className="font-mono text-3xl font-bold leading-none"
                  style={{ color: "#d1e0d7" }}
                >
                  {step}
                </span>
                <div>
                  <p className="font-semibold text-gray-900 leading-snug">{label}</p>
                  <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">{sub}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Insights section — concrete Dean message examples */}
      <section className="border-t bg-muted/40 px-6 py-16 md:py-24">
        <div className="mx-auto max-w-5xl">
          <div className="mb-12 text-center">
            <h2 className="mb-4 font-serif text-2xl font-normal md:text-3xl">
              Prevention. Adaptation. Recovery.
            </h2>
            <p className="mx-auto max-w-xl leading-relaxed text-muted-foreground">
              Whether you&apos;re trying to stay healthy, managing something that flared up, or rebuilding after time off. Coach Dean handles all three.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {["IT band syndrome", "shin splints", "plantar fasciitis", "stress reactions", "hip flexor pain", "achilles tendinopathy", "runner's knee", "hamstring strains"].map((injury) => (
                <span key={injury} className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs text-gray-500">{injury}</span>
              ))}
            </div>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            {/* Insight 1 — Injury sounding board (shin splints) */}
            <InsightCard
              context="After today's run"
              tag="Injury prevention"
              tagColor="#dc2626"
              messages={[
                { from: "user", text: "Left shin has been a bit sore the last two runs — not sharp, just there." },
                { from: "dean", text: "Classic early-stage medial shin stress. Usually means your mileage ramped a bit faster than your bone remodeling can keep up with. Ice it tonight, skip tomorrow's run, and I'll swap it for a pool session or bike day. We'll ease back in over 4–5 days. If it sharpens at all, ping me before you run again." },
              ]}
            />

            {/* Insight 2 — Return to run */}
            <InsightCard
              context="After 2 weeks off with IT band pain"
              tag="Return to run"
              tagColor="#f97316"
              messages={[
                { from: "user", text: "Knee felt fine on my test run yesterday. Safe to get back to normal?" },
                { from: "dean", text: "Good sign, but one pain-free run doesn't mean the tissue is ready for full load. Three easy 20-minute runs this week, flat routes only, no tempo. If all three feel clean, we step back up next week. I'll check in after each one and have your IT band strengthening routine ready to go." },
              ]}
            />

            {/* Insight 3 — Training calibration */}
            <InsightCard
              context="After Wednesday's 5.8mi run · 9:12/mi · 148ft gain"
              tag="Load monitoring"
              tagColor="#9333ea"
              messages={[
                { from: "dean", text: "Your last four runs have all landed at moderate effort. 148bpm today puts you right in the grey zone again. No real easy days, no real hard day. That pattern builds fatigue without building fitness, and it's a common injury setup. Try a genuinely easy 40 min tomorrow and Thursday's workout will land a lot better." },
              ]}
            />

            {/* Insight 4 — Real-time adaptation */}
            <InsightCard
              context="Tuesday morning"
              tag="Adapts to your life"
              tagColor="#0891b2"
              messages={[
                { from: "user", text: "Just did a heavy leg day — squats and deadlifts. Should I still run my 6 tonight?" },
                { from: "dean", text: "Skip the 6 tonight. Running heavy after that lift is how achilles and hamstring stuff sneaks in. Move tonight to a 30-min easy spin or full rest, shift the 6 to Wednesday, and bump Thursday's tempo to Friday so the legs get a real recovery window. Plan still works." },
              ]}
            />
          </div>
        </div>
      </section>

      {/* Comparison — directly below insights with simple bridge */}
      <section className="border-t px-6 py-16 md:py-24">
        <div className="mx-auto max-w-5xl">
          <div className="mb-12 text-center">
            <p className="text-sm uppercase tracking-widest text-muted-foreground mb-3">Works alongside the tools you already use</p>
            <h2 className="mb-4 font-serif text-2xl font-normal md:text-3xl">
              The missing layer between your plan and your potential.
            </h2>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {/* Training without coaching */}
            <div className="rounded-2xl border border-gray-200 bg-white p-6 flex flex-col gap-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">Training without coaching</p>
                <p className="font-serif text-lg font-normal text-gray-700">Apps alone</p>
              </div>
              <ul className="text-sm leading-relaxed text-muted-foreground flex-1 space-y-2">
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">✗</span> Plan tells you what to do. Nothing explains why.</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">✗</span> &ldquo;Workout Complete&rdquo; is the only feedback you get</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">✗</span> Load patterns go unnoticed until you&apos;re already sidelined</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">✗</span> Injury questions go to Google</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">✗</span> No one rebuilds your plan when you miss two weeks</li>
              </ul>
            </div>

            {/* Coach Dean — featured */}
            <div className="rounded-2xl bg-gray-900 p-6 flex flex-col gap-4 text-white md:-mt-4 md:-mb-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">The intelligence layer</p>
                <p className="font-serif text-lg font-normal">Coach Dean</p>
              </div>
              <ul className="text-sm leading-relaxed text-gray-300 flex-1 space-y-2">
                <li className="flex gap-2"><span className="text-green-400 mt-0.5">✓</span> Flags load spikes and grey-zone patterns before they become injuries</li>
                <li className="flex gap-2"><span className="text-green-400 mt-0.5">✓</span> Prescribes rehab exercises and cross-training so you stay fit while you heal</li>
                <li className="flex gap-2"><span className="text-green-400 mt-0.5">✓</span> Rebuilds your plan around injuries, illness, or missed weeks</li>
                <li className="flex gap-2"><span className="text-green-400 mt-0.5">✓</span> Works alongside Runna, TrainingPeaks, or any plan you already have</li>
                <li className="flex gap-2"><span className="text-green-400 mt-0.5">✓</span> Explains what your HR, pace, and cadence actually mean</li>
              </ul>
              <div>
                <p className="text-sm font-medium text-gray-300">Free to start, then $15 / month</p>
                <p className="text-xs text-gray-500 mt-0.5">Cancel anytime, no friction</p>
              </div>
            </div>

            {/* Human coach */}
            <div className="rounded-2xl border border-gray-200 bg-white p-6 flex flex-col gap-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">Private coach</p>
                <p className="font-serif text-lg font-normal text-gray-700">The gold standard</p>
              </div>
              <ul className="text-sm leading-relaxed text-muted-foreground flex-1 space-y-2">
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">~</span> Weekly adaptation; requires a call to change anything</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">~</span> Detailed feedback, but often delayed</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">~</span> Scheduled calls &amp; email only</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">✗</span> High friction: schedules, logins, check-ins</li>
              </ul>
              <p className="text-sm font-medium text-gray-500">$150–300 / month</p>
            </div>
          </div>
        </div>
      </section>

      {/* Insights — what Coach Dean delivers after every run */}
      <section className="border-t bg-muted/40 px-6 py-14 md:py-20">
        <div className="mx-auto max-w-4xl">
          <div className="mb-10 text-center">
            <p className="text-sm uppercase tracking-widest text-muted-foreground mb-3">What he looks at, every run</p>
            <h2 className="font-serif text-2xl font-normal md:text-3xl">
              Six lenses on every run.
            </h2>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:gap-x-8 md:gap-y-8">
            {[
              {
                title: "Load and injury risk",
                icon: (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="3" y1="20" x2="21" y2="20" />
                    <rect x="4" y="15" width="2.5" height="5" />
                    <rect x="8" y="12" width="2.5" height="8" />
                    <rect x="12" y="8" width="2.5" height="12" />
                    <rect x="16" y="5" width="2.5" height="15" fill="currentColor" />
                  </svg>
                ),
              },
              {
                title: "Aerobic efficiency",
                icon: (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="3,17 8,12 12,14 16,8 21,5" />
                    <polyline points="17,5 21,5 21,9" />
                  </svg>
                ),
              },
              {
                title: "Pacing and splits",
                icon: (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="3" y1="20" x2="21" y2="20" />
                    <rect x="4.5" y="13" width="3" height="7" />
                    <rect x="9.5" y="9" width="3" height="11" />
                    <rect x="14.5" y="11" width="3" height="9" />
                  </svg>
                ),
              },
              {
                title: "Cadence and form",
                icon: (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="5" r="2" />
                    <path d="M12 7 L10 12 L7 14" />
                    <path d="M12 7 L14 12 L17 14" />
                    <path d="M10 12 L9 18" />
                    <path d="M14 12 L15 18" />
                  </svg>
                ),
              },
              {
                title: "Wins and milestones",
                icon: (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 3 L13.9 8.6 L19.8 8.6 L15 12.1 L16.9 17.7 L12 14.2 L7.1 17.7 L9 12.1 L4.2 8.6 L10.1 8.6 Z" />
                  </svg>
                ),
              },
              {
                title: "How this fits your goal",
                icon: (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="8" />
                    <circle cx="12" cy="12" r="3.5" />
                    <circle cx="12" cy="12" r="0.5" fill="currentColor" />
                  </svg>
                ),
              },
            ].map(({ title, icon }) => (
              <div key={title} className="flex flex-col items-center gap-3 text-center">
                <div className="h-10 w-10 text-[#1a5c35]">{icon}</div>
                <p className="text-sm font-semibold text-gray-900 leading-snug">{title}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Testimonials */}
      <section className="border-t px-6 py-16 md:py-24">
        <div className="mx-auto max-w-4xl text-center">
          <p className="mb-8 text-xs uppercase tracking-widest text-muted-foreground">From the athletes</p>
          <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
            {[
              {
                quote: "Coach Dean made all the difference in my most recent ultra race. He helped me strategize mileage build, nutrition, apparel, and so much more — and kept me organized and motivated throughout.",
                name: "Luke S.",
                detail: "Ultramarathon finisher",
              },
              {
                quote: "I'm training for a half marathon and Coach Dean has truly been so helpful! He's kept me motivated and helped to work in cross training and proper pacing. It feels like I'm talking to an actual coach with a consistent personality.",
                name: "Madie D.",
                detail: "Training for a half marathon",
              },
            ].map(({ quote, name, detail }) => (
              <figure key={name} className="flex flex-col items-center gap-4">
                <span className="font-serif text-5xl leading-none text-gray-200" aria-hidden="true">&ldquo;</span>
                <blockquote className="font-serif text-lg font-normal leading-relaxed text-gray-800 md:text-xl" style={{ marginTop: "-1.25rem" }}>
                  {quote}
                </blockquote>
                <figcaption className="flex items-center gap-3">
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: "50%",
                      background: "#1a5c35",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <span style={{ fontFamily: SYS_FONT, fontSize: 12, fontWeight: 600, color: "#ffffff" }}>
                      {name.charAt(0)}
                    </span>
                  </div>
                  <div className="text-left">
                    <p className="text-sm font-semibold text-gray-900 leading-tight">{name}</p>
                    <p className="text-xs text-muted-foreground leading-tight">{detail}</p>
                  </div>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t bg-muted/40 px-6 py-16 md:py-24">
        <div className="mx-auto max-w-2xl">
          <h2 className="mb-10 text-center font-serif text-2xl font-normal md:text-3xl">
            Frequently asked questions
          </h2>
          <div className="divide-y">
            {[
              {
                q: "I already use Runna or TrainingPeaks. Do I need Coach Dean?",
                a: (
                  <>
                    <p>Yes, and this is actually our most common use case. Runna gives you the plan. Coach Dean gives you the intelligence layer on top of it: a coaching note after every run, load monitoring, and a direct line for training questions. Keep your Runna structure. Coach Dean adds what no app does.</p>
                    <p className="mt-3">Text Coach Dean a PDF of your plan and he&apos;ll ingest it automatically, then reference it directly when giving you feedback. So instead of &ldquo;you ran 8:45 pace,&rdquo; you get &ldquo;that was your recovery day, 8:45 with 140bpm HR is exactly right, your legs should feel fresher by Thursday.&rdquo;</p>
                  </>
                ),
              },
              {
                q: "Can Coach Dean actually prevent injuries?",
                a: (
                  <>
                    <p>Coach Dean is genuinely good at catching the patterns that precede most running injuries: load spikes, declining aerobic efficiency, and grey-zone effort distribution. He flags them early so you can act conservatively. He&apos;s not a physio and can&apos;t diagnose anything, but he&apos;s the early warning system most runners are missing.</p>
                    <p className="mt-3">When something does flare up, Coach Dean will prescribe specific rehab exercises for common running injuries (IT band, shin splints, plantar fasciitis, hip flexor tightness) and swap affected sessions for cross-training alternatives like pool running, cycling, or the elliptical so your fitness doesn&apos;t evaporate while you recover. The goal is to stay in training, not just to rest and hope.</p>
                  </>
                ),
              },
              {
                q: "Can Coach Dean help me if I'm not training for a specific race?",
                a: "Yes, especially if you're coming back from injury or trying to stay consistent through a high-mileage stretch. That said, Coach Dean is at his best with a goal on the calendar. If you don't have one yet, tell him where you're at and he'll help you pick something realistic.",
              },
              {
                q: "What type of races can Coach Dean help me prepare for?",
                a: "Coach Dean can build training plans for 5Ks all the way up to ultramarathons, including half marathons, full marathons, and trail races. Not sure what distance is right for you? Tell Coach Dean where you're at and he'll help you figure it out.",
              },
              {
                q: "Do I need Strava or a GPS watch?",
                a: (
                  <>
                    <p>Technically no, all you need is a phone number. But connecting Strava unlocks the best version of Coach Dean. He pulls your full activity history (recent paces, long run efforts, workout splits) to build a real picture of your fitness before your first plan is written, and sends you coaching feedback within minutes of every run finishing. It&apos;s the feature testers have found most valuable.</p>
                    <p className="mt-3">If you don&apos;t use Strava, Coach Dean asks for a recent race time or your comfortable conversational pace and calculates your training zones from there using the same pace formulas elite coaches use. Those zones get refined over time as you share feedback over text.</p>
                  </>
                ),
              },
              {
                q: "What kinds of insights does Coach Dean give me after a run?",
                a: (
                  <>
                    <p>Six different lenses, every time your run syncs from Strava. Coach Dean weighs all of them and surfaces whichever one is most worth saying that day:</p>
                    <ul className="mt-3 space-y-2 list-disc pl-5">
                      <li><span className="font-semibold text-foreground">Aerobic efficiency.</span> Pace at HR over time, so you can see fitness moving in the data, not just on race day.</li>
                      <li><span className="font-semibold text-foreground">Pacing and splits.</span> First-half vs second-half, fade detection, whether you went out too hot.</li>
                      <li><span className="font-semibold text-foreground">Effort zone audit.</span> Catches the grey-zone trap where every run lives at moderate effort and nothing moves forward.</li>
                      <li><span className="font-semibold text-foreground">Load monitoring.</span> This week vs your four-week average, week-over-week changes, milestone runs (longest in 30 days, YTD totals).</li>
                      <li><span className="font-semibold text-foreground">Cadence and form trends.</span> 10-run cadence average, with cues if it&apos;s drifting in a direction worth nudging.</li>
                      <li><span className="font-semibold text-foreground">Workout-vs-intent check.</span> Did today&apos;s tempo land in tempo zone? Did the long run actually stay easy? Coach Dean compares execution to the prescribed effort.</li>
                    </ul>
                  </>
                ),
              },
              {
                q: "Does Coach Dean build me a training plan?",
                a: "Yes, from scratch, based on your goal, current fitness, and schedule. But the plan is a starting point, not the product. The real value is what happens after every run.",
              },
              {
                q: "How much does Coach Dean cost?",
                a: "It's free for the first 7 days. Cancel with no penalties. After that, $15/mo.",
              },
              {
                q: "What training philosophy does Coach Dean follow?",
                a: "Polarized 80/20 training, Lydiard-style aerobic base building, and Jack Daniels VDOT pacing, with targeted strength and mobility work woven in. The specifics are always adapted to your fitness, schedule, and goal race.",
              },
              {
                q: "What happens if I miss a workout or need to take a week off?",
                a: "Just tell Coach Dean. Seriously, text him like you'd text a coach. Whether you missed a run, got sick, or needed a mental break, Coach Dean will adjust your upcoming week to account for it and keep you on track toward your goal. Life happens, and a good coach works around it rather than ignoring it.",
              },
              {
                q: "Are there any special commands I can text Coach Dean?",
                a: (
                  <>
                    <p>Beyond just chatting, a few keywords trigger specific actions:</p>
                    <ul className="mt-3 space-y-2">
                      <li><span className="font-mono font-semibold text-foreground">FEEDBACK</span>: send a note directly to the Coach Dean team. Use this to report a bug, share a suggestion, or tell us something Coach Dean got wrong.</li>
                      <li><span className="font-mono font-semibold text-foreground">STRAVA CONNECTION</span>: get a link to update your Strava permissions, including adding or removing the coaching notes that appear on each activity.</li>
                      <li><span className="font-mono font-semibold text-foreground">UPDATE PLAN</span>: confirms a full plan rebuild after Coach Dean proposes one. Useful when your goal, schedule, or fitness has shifted.</li>
                      <li><span className="font-mono font-semibold text-foreground">UNSUBSCRIBE</span>: get a link to cancel your subscription at any time.</li>
                      <li><span className="font-mono font-semibold text-foreground">STOP</span>: stop all messages immediately. You&apos;ll also receive a link to cancel billing. Text START to resume at any time.</li>
                    </ul>
                    <p className="mt-3">Everything else is just plain conversation. Ask questions, report a run, tell Coach Dean your knee hurts. He handles it.</p>
                  </>
                ),
              },
              {
                q: "Is my data private?",
                a: "Your training data, pace information, and conversations with Coach Dean are used solely to power your coaching experience, nothing else. We don't sell your data or share it with third parties. If you connect Strava, that access is only used to pull your workout history into Coach Dean and optionally add a coaching note to each activity. You control the notes permission during setup. You can request deletion of your data at any time by texting FEEDBACK: Delete my account.",
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
      <section className="flex flex-col items-center gap-6 border-t px-6 py-16 text-center md:py-24">
        <h2 className="max-w-xl font-serif text-2xl font-normal md:text-3xl">
          Stop losing weeks to injury.
        </h2>
        <p className="max-w-md text-muted-foreground leading-relaxed">
          Your first 7 days are free. Tell Coach Dean where you&apos;re at: staying healthy, managing something that flared up, or rebuilding after time off. He&apos;ll take it from there.
        </p>
        <Suspense>
          <SignupForm smsPhone={smsPhone} centered />
        </Suspense>
      </section>

      {/* Footer */}
      <footer className="border-t px-6 py-10 text-center text-sm text-muted-foreground">
        <div className="mx-auto flex max-w-2xl flex-col items-center gap-3">
          <p className="font-medium text-foreground">Coach Dean</p>
          <p>
            Questions or feedback?{" "}
            <a
              href="mailto:hello@coachdean.ai"
              className="underline hover:text-foreground"
            >
              hello@coachdean.ai
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
