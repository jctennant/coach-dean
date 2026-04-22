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
              An expert running coach in your pocket.
            </h1>
            <p className="text-lg" style={{ color: "#4a4a4a" }}>
              Connect Strava and get instant feedback after every run — what it means, what to do tomorrow, and when to rest. All over text.
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
              { step: "01", label: "Connect Strava", sub: "One tap — Coach Dean reads your full history and knows your fitness baseline from day one." },
              { step: "02", label: "Coach Dean analyzes every run and texts you", sub: "Coaching note the moment your run syncs. Ask anything, any time." },
              { step: "03", label: "Train with confidence, not guesswork", sub: "Know when to push, when to back off, and why it's working." },
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
              Coach Dean catches what your watch doesn&apos;t tell you.
            </h2>
            <p className="mx-auto max-w-xl leading-relaxed text-muted-foreground">
              Not &ldquo;great run!&rdquo; notifications. Actual analysis from your Strava data — the kind that changes what you do next.
            </p>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            {/* Insight 1 — Injury sounding board (shin splints) */}
            <InsightCard
              context="After today's run"
              tag="Injury sounding board"
              tagColor="#dc2626"
              messages={[
                { from: "user", text: "Left shin has been a bit sore the last two runs — not sharp, just there." },
                { from: "dean", text: "Classic early-stage medial shin stress. Usually means your mileage ramped a bit faster than your bone remodeling can keep up with. Ice it tonight, skip tomorrow's run, and I'll swap it for a pool session or bike day. We'll ease back in over 4–5 days. If it sharpens at all, ping me before you run again." },
              ]}
            />

            {/* Insight 2 — Training calibration */}
            <InsightCard
              context="After Wednesday's 5.8mi run · 9:12/mi · 148ft gain"
              tag="Training calibration"
              tagColor="#9333ea"
              messages={[
                { from: "dean", text: "Nice work getting this one in. That said, your last four runs have all landed at moderate effort — 148bpm average today puts you right in the grey zone again. No real easy days, no real hard day. That pattern builds fatigue without building much fitness. Try a genuinely easy 40 min tomorrow and Thursday's workout will land a lot better." },
              ]}
            />

            {/* Insight 3 — Fitness building */}
            <InsightCard
              context="Your 6-week progress check"
              tag="Fitness progress"
              tagColor="#16a34a"
              messages={[
                { from: "dean", text: "Your aerobic efficiency is up 9% over the last 6 weeks — you're running the same pace at a meaningfully lower heart rate. That's your base building in real time. Keep the easy days truly easy and this trend will carry you right through your build phase." },
              ]}
            />

            {/* Insight 4 — Load management */}
            <InsightCard
              context="After a big training week"
              tag="Load management"
              tagColor="#0891b2"
              messages={[
                { from: "dean", text: "Big week — you've logged 43% more than your 4-week average. That's real training stimulus. Keep Friday short and easy so your body can actually absorb it. Fitness built on fresh legs sticks; fitness stacked on top of fatigue tends not to." },
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
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">✗</span> Plan tells you what to do — nothing explains why</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">✗</span> &ldquo;Workout Complete&rdquo; is the only feedback you get</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">✗</span> Load builds blind — no one flags what&apos;s coming</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">✗</span> Injury questions go to Google</li>
              </ul>
            </div>

            {/* Coach Dean — featured */}
            <div className="rounded-2xl bg-gray-900 p-6 flex flex-col gap-4 text-white md:-mt-4 md:-mb-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">The intelligence layer</p>
                <p className="font-serif text-lg font-normal">Coach Dean</p>
              </div>
              <ul className="text-sm leading-relaxed text-gray-300 flex-1 space-y-2">
                <li className="flex gap-2"><span className="text-green-400 mt-0.5">✓</span> Tracks whether training is actually building fitness</li>
                <li className="flex gap-2"><span className="text-green-400 mt-0.5">✓</span> Tells you when to push and when to back off</li>
                <li className="flex gap-2"><span className="text-green-400 mt-0.5">✓</span> Explains every run in plain language</li>
                <li className="flex gap-2"><span className="text-green-400 mt-0.5">✓</span> Flags load patterns before they interrupt training</li>
                <li className="flex gap-2"><span className="text-green-400 mt-0.5">✓</span> Works alongside Runna, TrainingPeaks, or any plan</li>
              </ul>
              <div>
                <p className="text-sm font-medium text-gray-300">Free to start, then $10 / month</p>
                <p className="text-xs text-gray-500 mt-0.5">Cancel anytime — no friction</p>
              </div>
            </div>

            {/* Human coach */}
            <div className="rounded-2xl border border-gray-200 bg-white p-6 flex flex-col gap-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">Private coach</p>
                <p className="font-serif text-lg font-normal text-gray-700">The gold standard</p>
              </div>
              <ul className="text-sm leading-relaxed text-muted-foreground flex-1 space-y-2">
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">~</span> Weekly adaptation — requires a call to change anything</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">~</span> Detailed feedback, but often delayed</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">~</span> Scheduled calls &amp; email only</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">✗</span> High friction: schedules, logins, check-ins</li>
              </ul>
              <p className="text-sm font-medium text-gray-500">$150–300 / month</p>
            </div>
          </div>
        </div>
      </section>

      {/* Fitness over time — dashboard mock */}
      <section className="border-t bg-muted/40 px-6 py-16 md:py-24">
        <div className="mx-auto max-w-5xl">
          <div className="mb-10 text-center">
            <h2 className="mb-4 font-serif text-2xl font-normal md:text-3xl">
              Watch your fitness build in real time.
            </h2>
            <p className="mx-auto max-w-xl leading-relaxed text-muted-foreground">
              Coach Dean tracks the signal beneath the noise — aerobic efficiency, training load, zone distribution — and surfaces it in a dashboard you can actually read. Not raw data. A picture of whether your training is working.
            </p>
          </div>

          {/* Dashboard mock */}
          <div className="rounded-2xl border border-gray-200 bg-white p-6 md:p-8 space-y-6">
            {/* Header row */}
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-400 mb-0.5">Dashboard · Last 6 weeks</p>
                <p className="text-base font-semibold text-gray-900">Sarah M. · NYC Marathon build</p>
              </div>
              <div className="flex gap-5 text-right shrink-0">
                <div>
                  <p className="text-xl font-bold text-green-700 leading-none">+11%</p>
                  <p className="text-[11px] text-gray-400 mt-0.5">aerobic efficiency</p>
                </div>
                <div>
                  <p className="text-xl font-bold text-gray-900 leading-none">42 mi</p>
                  <p className="text-[11px] text-gray-400 mt-0.5">this week</p>
                </div>
              </div>
            </div>

            {/* Run zone strip — dots per run, colored by effort, grouped by week */}
            <div>
              <p className="text-xs font-medium text-gray-500 mb-3">Training zones — each dot is a run</p>
              {/* Dot strip — mirrors production RunZoneStrip exactly */}
              <svg viewBox="0 0 520 32" className="w-full" aria-label="Run zone history">
                {/* Week 1: Mar 17 — 5 runs */}
                <circle cx="10"  cy="10" r="9" fill="#22c55e" opacity="0.85" />
                <circle cx="31"  cy="10" r="9" fill="#22c55e" opacity="0.85" />
                <circle cx="52"  cy="10" r="9" fill="#22c55e" opacity="0.85" />
                <circle cx="73"  cy="10" r="9" fill="#f59e0b" opacity="0.85" />
                <circle cx="94"  cy="10" r="9" fill="#22c55e" opacity="0.85" />
                <text x="52" y="29" textAnchor="middle" fontSize="7" fill="#9ca3af">Mar 17</text>
                {/* Week 2: Mar 24 — 5 runs */}
                <circle cx="126" cy="10" r="9" fill="#22c55e" opacity="0.85" />
                <circle cx="147" cy="10" r="9" fill="#22c55e" opacity="0.85" />
                <circle cx="168" cy="10" r="9" fill="#ef4444" opacity="0.85" />
                <circle cx="189" cy="10" r="9" fill="#22c55e" opacity="0.85" />
                <circle cx="210" cy="10" r="9" fill="#22c55e" opacity="0.85" />
                <text x="168" y="29" textAnchor="middle" fontSize="7" fill="#9ca3af">Mar 24</text>
                {/* Week 3: Mar 31 — 5 runs */}
                <circle cx="242" cy="10" r="9" fill="#22c55e" opacity="0.85" />
                <circle cx="263" cy="10" r="9" fill="#22c55e" opacity="0.85" />
                <circle cx="284" cy="10" r="9" fill="#f59e0b" opacity="0.85" />
                <circle cx="305" cy="10" r="9" fill="#22c55e" opacity="0.85" />
                <circle cx="326" cy="10" r="9" fill="#ef4444" opacity="0.85" />
                <text x="284" y="29" textAnchor="middle" fontSize="7" fill="#9ca3af">Mar 31</text>
                {/* Week 4: Apr 7 — 4 runs (deload) */}
                <circle cx="358" cy="10" r="9" fill="#22c55e" opacity="0.85" />
                <circle cx="379" cy="10" r="9" fill="#22c55e" opacity="0.85" />
                <circle cx="400" cy="10" r="9" fill="#22c55e" opacity="0.85" />
                <circle cx="421" cy="10" r="9" fill="#22c55e" opacity="0.85" />
                <text x="389" y="29" textAnchor="middle" fontSize="7" fill="#9ca3af">Apr 7</text>
                {/* Week 5: Apr 14 — 4 runs (current, partial) */}
                <circle cx="453" cy="10" r="9" fill="#22c55e" opacity="0.85" />
                <circle cx="474" cy="10" r="9" fill="#22c55e" opacity="0.85" />
                <circle cx="495" cy="10" r="9" fill="#ef4444" opacity="0.85" />
                <circle cx="516" cy="10" r="9" fill="#22c55e" opacity="0.85" />
                <text x="484" y="29" textAnchor="middle" fontSize="7" fill="#9ca3af">Apr 14</text>
              </svg>
              {/* Legend */}
              <div className="flex flex-wrap gap-4 mt-3">
                {[
                  { label: "Easy", color: "#22c55e" },
                  { label: "Moderate", color: "#f59e0b" },
                  { label: "Hard", color: "#ef4444" },
                  { label: "Race", color: "#3b82f6" },
                ].map(({ label, color }) => (
                  <span key={label} className="flex items-center gap-1.5 text-xs text-gray-500">
                    <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                    {label}
                  </span>
                ))}
              </div>
            </div>

            {/* Zone % breakdown */}
            <div>
              <p className="text-xs font-medium text-gray-500 mb-2">Zone distribution — last 4 weeks</p>
              <div className="flex gap-4 flex-wrap mb-2">
                {[
                  { label: "Easy (Z1–2)", pct: 76, color: "#22c55e" },
                  { label: "Moderate (Z3)", pct: 8, color: "#f59e0b" },
                  { label: "Hard (Z4–5)", pct: 16, color: "#ef4444" },
                ].map(({ label, pct, color }) => (
                  <div key={label} className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                    <span className="text-xs text-gray-600">{label}</span>
                    <span className="text-xs font-semibold text-gray-900">{pct}%</span>
                  </div>
                ))}
              </div>
              <div className="h-2 w-full rounded-full overflow-hidden flex">
                <div className="h-full" style={{ width: "76%", backgroundColor: "#22c55e" }} />
                <div className="h-full" style={{ width: "8%",  backgroundColor: "#f59e0b" }} />
                <div className="h-full" style={{ width: "16%", backgroundColor: "#ef4444" }} />
              </div>
            </div>

            {/* Aerobic efficiency line */}
            <div>
              <p className="text-xs font-medium text-gray-500 mb-2">Aerobic efficiency trend — higher is better</p>
              <svg viewBox="0 0 560 80" className="w-full" style={{ minWidth: "200px" }} aria-label="Aerobic efficiency trend">
                {/* Trend line — gentle upward slope matching production LineChart */}
                <polyline
                  points="4,68 74,62 144,55 214,50 284,46 354,38 430,30 556,22"
                  fill="none" stroke="#166534" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"
                />
                <circle cx="556" cy="22" r="3.5" fill="#166534" />
              </svg>
            </div>
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
                q: "I already use Runna or TrainingPeaks — do I need Coach Dean?",
                a: (
                  <>
                    <p>Yes — this is actually our most common use case. Runna gives you the plan. Coach Dean gives you the intelligence layer on top of it: a coaching note after every run, load monitoring, and a direct line for training questions. Keep your Runna structure; Coach Dean adds what no app does.</p>
                    <p className="mt-3">You can upload your plan as a PDF to the dashboard and Coach Dean will reference it directly when giving you feedback. So instead of "you ran 8:45 pace," you get "that was your recovery day — 8:45 with 140bpm HR is exactly right, your legs should feel fresher by Thursday."</p>
                  </>
                ),
              },
              {
                q: "Can Coach Dean actually prevent injuries?",
                a: (
                  <>
                    <p>Coach Dean is genuinely good at catching the patterns that precede most running injuries — load spikes, declining aerobic efficiency, grey-zone effort distribution — and flagging them early so you can act conservatively. He&apos;s not a physio and can&apos;t diagnose anything, but he&apos;s the early warning system most runners are missing.</p>
                    <p className="mt-3">When something does flare up, Coach Dean will prescribe specific rehab exercises for common running injuries — IT band, shin splints, plantar fasciitis, hip flexor tightness — and swap affected sessions for cross-training alternatives (pool running, cycling, elliptical) so your fitness doesn&apos;t evaporate while you recover. The goal is to stay in training, not just to rest and hope.</p>
                  </>
                ),
              },
              {
                q: "Can Coach Dean help me if I'm not training for a specific race?",
                a: (
                  <>
                    <p>Absolutely — no race on the calendar required. Plenty of Coach Dean&apos;s athletes are focused on building consistent mileage, staying healthy through a high-mileage stretch, or returning from injury. If you&apos;re coming back from something, Coach Dean will ask about your current status and build your program around staying healthy first, performance second.</p>
                    <p className="mt-3">If you just want to run more consistently and stop getting hurt every time you ramp up, that&apos;s a perfectly complete goal. Coach Dean tracks your load, checks in after every run, and flags patterns before they become injuries.</p>
                  </>
                ),
              },
              {
                q: "What type of races can Coach Dean help me prepare for?",
                a: "Coach Dean can build training plans for 5Ks all the way up to ultramarathons, including half marathons, full marathons, and trail races. If you're training for a triathlon, he focuses on the run leg — your running program will be dialed in, but for swim and bike you'd want dedicated coaching alongside. Not sure what distance is right for you? Tell Coach Dean where you're at and he'll help you figure it out.",
              },
              {
                q: "How does Coach Dean know what paces to assign my workouts?",
                a: (
                  <>
                    <p>The best way is to connect Strava during onboarding. Coach Dean pulls your full activity history — recent paces, long run efforts, workout splits — and uses that to build a real picture of your current fitness before your first plan is written. No questionnaire can replace actual data.</p>
                    <p className="mt-3">If you don&apos;t use Strava, Coach Dean asks for a recent race time or your comfortable conversational pace and calculates your training zones from there using established pace formulas (the same ones elite coaches use). As you train and share feedback over text, those zones get refined over time.</p>
                  </>
                ),
              },
              {
                q: "Do I need a GPS watch or Strava to use Coach Dean?",
                a: (
                  <>
                    <p>No — all you need is a phone number. Coach Dean works entirely over SMS with no app, account, or device required.</p>
                    <p className="mt-3">That said, connecting Strava unlocks the best version of Coach Dean. He&apos;ll analyze your history to build a sharper plan from day one, and send you coaching feedback within minutes of every run finishing — pace trends, effort level, whether the workout matched the intent. It&apos;s the feature testers have found most valuable.</p>
                  </>
                ),
              },
              {
                q: "Does Coach Dean build me a training plan?",
                a: "Yes, if you need one — Coach Dean will build a plan from scratch based on your goal, current fitness, and schedule. But plan generation is a starting point, not the product. The real value is what happens after every run: coaching notes, load tracking, and real-time adjustments as your training evolves. If you already follow Runna or TrainingPeaks, Coach Dean works alongside it and you skip the plan setup entirely.",
              },
              {
                q: "How much does Coach Dean cost?",
                a: "It's free for the first 7 days — cancel with no penalties. After that, $10/mo on an annual plan or $20/mo month-to-month.",
              },
              {
                q: "What training philosophy does Coach Dean follow?",
                a: "Dean applies evidence-based principles used by elite coaches — polarized 80/20 training (easy runs truly easy, hard days genuinely hard), Lydiard-style aerobic base building before race-specific work, and Jack Daniels VDOT pacing for accurate zone calculation. He also incorporates targeted strength and mobility work — single-leg and hip exercises that keep runners healthy and absorbing load through a full season. The specifics are always adapted to your fitness level, schedule, and goal race.",
              },
              {
                q: "What happens if I miss a workout or need to take a week off?",
                a: "Just tell Coach Dean. Seriously — text him like you'd text a coach. Whether you missed a run, got sick, or needed a mental break, Coach Dean will adjust your upcoming week to account for it and keep you on track toward your goal. Life happens, and a good coach works around it rather than ignoring it.",
              },
              {
                q: "Are there any special commands I can text Coach Dean?",
                a: (
                  <>
                    <p>Beyond just chatting, a few keywords trigger specific actions:</p>
                    <ul className="mt-3 space-y-2">
                      <li><span className="font-mono font-semibold text-foreground">FEEDBACK</span> — send a note directly to the Coach Dean team. Use this to report a bug, share a suggestion, or tell us something Coach Dean got wrong.</li>
                      <li><span className="font-mono font-semibold text-foreground">DASHBOARD</span> — get a link to your training dashboard, where you can see your current week and upcoming schedule.</li>
                      <li><span className="font-mono font-semibold text-foreground">UNSUBSCRIBE</span> — get a link to cancel your subscription at any time.</li>
                      <li><span className="font-mono font-semibold text-foreground">STOP</span> — stop all messages immediately. You&apos;ll also receive a link to cancel billing. Text START to resume at any time.</li>
                    </ul>
                    <p className="mt-3">Everything else is just plain conversation — ask questions, report a run, tell Coach Dean your knee hurts. He handles it.</p>
                  </>
                ),
              },
              {
                q: "Is my data private?",
                a: "Your training data, pace information, and conversations with Coach Dean are used solely to power your coaching experience — nothing else. We don't sell your data or share it with third parties. If you connect Strava, that access is read-only and only used to pull your workout history into Coach Dean. You can request deletion of your data at any time by texting FEEDBACK: Delete my account.",
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
          Ready to run smarter?
        </h2>
        <p className="max-w-md text-muted-foreground leading-relaxed">
          Your first 7 days are free. Cancel any time — no friction, no forms. Just text Coach Dean and go.
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
