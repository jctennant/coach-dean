"use client";

const ROW_ONE = [
  "Boston Marathon",
  "Ironman 70.3",
  "5K PR",
  "NYC Marathon",
  "Ironman World Champs",
  "Half Marathon PR",
  "Olympic Tri",
  "Gorge Waterfalls 100K",
  "Chicago Marathon",
  "Sprint Triathlon",
];

const ROW_TWO = [
  "Western States 100",
  "Cirque Series",
  "Philadephia Marathon",
  "10K",
  "Broken Arrow 46K",
  "Ironman 70.3 World Champs",
  "California International Marathon",
  "Mile Time Trial",
  "Paris Marathon",
  "Behind the Rocks 50 Miler",
];

function Pill({ label }: { label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-border bg-background px-4 py-1.5 text-sm text-muted-foreground shadow-sm">
      {label}
    </span>
  );
}

function MarqueeRow({ items, reverse = false }: { items: string[]; reverse?: boolean }) {
  // Duplicate for seamless loop
  const doubled = [...items, ...items];
  return (
    <div className="flex overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]">
      <div
        className="flex min-w-full shrink-0 gap-3 py-1"
        style={{
          animation: `marquee${reverse ? "-reverse" : ""} 30s linear infinite`,
        }}
      >
        {doubled.map((label, i) => (
          <Pill key={i} label={label} />
        ))}
      </div>
      <div
        aria-hidden
        className="flex min-w-full shrink-0 gap-3 py-1"
        style={{
          animation: `marquee${reverse ? "-reverse" : ""} 30s linear infinite`,
        }}
      >
        {doubled.map((label, i) => (
          <Pill key={i} label={label} />
        ))}
      </div>
    </div>
  );
}

export function RaceMarquee() {
  return (
    <section className="border-t bg-muted/40 py-12">
      <p className="mb-6 text-center text-sm font-medium uppercase tracking-widest text-muted-foreground">
        Loved by athletes training for
      </p>
      <div className="flex flex-col gap-3 overflow-hidden">
        <MarqueeRow items={ROW_ONE} />
        <MarqueeRow items={ROW_TWO} reverse />
      </div>
    </section>
  );
}
