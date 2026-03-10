/**
 * Test script for the weather module.
 * Run with: node scripts/test-weather.mjs
 *
 * Tests:
 * 1. Geocoding (city + state → lat/lon)
 * 2. Forecast fetch (lat/lon → 7-day daily data)
 * 3. buildWeatherBlock output for a few synthetic scenarios
 */

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

async function geocode(city, timezone) {
  const url = `${GEOCODING_URL}?name=${encodeURIComponent(city)}&count=5&language=en&format=json`;
  console.log(`\n[geocode] GET ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const usResults = (data.results ?? []).filter(r => r.country_code === "US");
  if (usResults.length === 0) throw new Error("No US geocoding result found");
  const match = usResults.find(r => r.timezone === timezone) ?? usResults[0];
  console.log("[geocode] matched:", JSON.stringify({ name: match.name, admin1: match.admin1, timezone: match.timezone, lat: match.latitude, lon: match.longitude }, null, 2));
  return { lat: match.latitude, lon: match.longitude, name: match.name, country: match.country };
}

async function fetchForecast(lat, lon, timezone) {
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    daily: [
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_sum",
      "weathercode",
      "windspeed_10m_max",
    ].join(","),
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "mm",
    timezone,
    forecast_days: "7",
  });

  const url = `${FORECAST_URL}?${params}`;
  console.log(`\n[forecast] GET ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Forecast failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.daily;
}

function weatherLabel(code) {
  if (code === 0) return "clear";
  if (code <= 3) return "partly cloudy";
  if (code <= 48) return "foggy";
  if (code <= 55) return "drizzle";
  if (code <= 65) return "rain";
  if (code <= 77) return "snow";
  if (code <= 82) return "rain showers";
  if (code <= 86) return "snow showers";
  if (code >= 95) return "thunderstorm";
  return "mixed conditions";
}

function buildWeatherBlock(days, location, timezone) {
  const dayFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "numeric",
    day: "numeric",
  });

  const notable = [];

  for (let i = 0; i < days.time.length; i++) {
    const date = days.time[i];
    const maxTempF = Math.round(days.temperature_2m_max[i]);
    const minTempF = Math.round(days.temperature_2m_min[i]);
    const precipMm = Math.round(days.precipitation_sum[i] * 10) / 10;
    const weatherCode = days.weathercode[i];
    const maxWindMph = Math.round(days.windspeed_10m_max[i]);

    const isThunderstorm = weatherCode >= 95;
    const isSnow = weatherCode >= 71 && weatherCode <= 86;
    const isHeavyRain = (weatherCode >= 61 && weatherCode <= 65) || (weatherCode >= 80 && weatherCode <= 82);

    const conditions = [];
    const coachingNotes = [];

    if (maxTempF < 20) {
      conditions.push(`extreme cold (high ${maxTempF}°F)`);
      coachingNotes.push("Dangerous cold — treadmill is a real option worth mentioning.");
    } else if (maxTempF < 32) {
      conditions.push(`freezing (high ${maxTempF}°F, low ${minTempF}°F)`);
      coachingNotes.push("Ice is the main thing to flag — especially early morning.");
    } else if (maxTempF < 45) {
      conditions.push(`cold (high ${maxTempF}°F)`);
      coachingNotes.push("Cold but runnable. Worth a mention for harder sessions.");
    } else if (maxTempF >= 90) {
      conditions.push(`extreme heat (high ${maxTempF}°F)`);
      coachingNotes.push(`${maxTempF}°F is tough — pace slips and that's expected. Early morning or evening are the best windows.`);
    } else if (maxTempF >= 80) {
      conditions.push(`hot (high ${maxTempF}°F)`);
      coachingNotes.push("Effort will feel harder than pace suggests. Hydration worth a mention for longer runs.");
    } else if (maxTempF >= 70 && minTempF >= 60) {
      conditions.push(`warm (high ${maxTempF}°F)`);
      coachingNotes.push("Warmer than ideal. Early morning is the best window.");
    }

    if (isThunderstorm) {
      conditions.push("thunderstorms");
      coachingNotes.push("Moving inside is just sensible — mention as a natural swap.");
    } else if (isSnow && precipMm > 2) {
      conditions.push(`snow (${precipMm}mm)`);
      coachingNotes.push("Worth a heads-up. Treadmill is an easy alternative to mention.");
    } else if (isHeavyRain && precipMm > 10) {
      conditions.push(`heavy rain (${precipMm}mm)`);
      coachingNotes.push("Worth flagging for quality sessions. Treadmill as an option, not a requirement.");
    } else if (precipMm > 5) {
      conditions.push(`rain (${weatherLabel(weatherCode)}, ${precipMm}mm)`);
    }

    if (maxWindMph >= 30) {
      conditions.push(`strong wind (${maxWindMph}mph)`);
      coachingNotes.push("Effort will feel harder than pace shows on exposed sections.");
    } else if (maxWindMph >= 20) {
      conditions.push(`windy (${maxWindMph}mph)`);
      coachingNotes.push("Go by feel rather than hitting a pace target.");
    }

    if (conditions.length > 0) {
      const dateObj = new Date(date + "T12:00:00");
      notable.push({
        label: dayFormatter.format(dateObj),
        conditions,
        coachingNotes,
      });
    }
  }

  if (notable.length === 0) {
    return `WEATHER FORECAST — ${location}: All 7 days look ideal for running. No notable conditions.\n`;
  }

  const lines = notable.map(d =>
    `${d.label}: ${d.conditions.join(", ")}. ${d.coachingNotes.join(" ")}`
  );

  return `WEATHER FORECAST — ${location} (next 7 days, notable days only):\n${lines.join("\n")}\n`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const testCities = [
  { city: "Denver", state: "CO", timezone: "America/Denver" },
  { city: "New York", state: "NY", timezone: "America/New_York" },
  { city: "Austin", state: "TX", timezone: "America/Chicago" },
];

for (const { city, state, timezone } of testCities) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Testing: ${city}, ${state}`);
  console.log("=".repeat(60));

  try {
    const coords = await geocode(city, timezone);
    console.log(`\n✓ Geocoded: ${coords.name}, ${coords.country} → lat ${coords.lat}, lon ${coords.lon}`);

    const daily = await fetchForecast(coords.lat, coords.lon, timezone);
    console.log(`\n✓ Forecast received for ${daily.time.length} days:`);
    for (let i = 0; i < daily.time.length; i++) {
      console.log(
        `  ${daily.time[i]}: high ${Math.round(daily.temperature_2m_max[i])}°F / low ${Math.round(daily.temperature_2m_min[i])}°F, ` +
        `precip ${daily.precipitation_sum[i]}mm, code ${daily.weathercode[i]} (${weatherLabel(daily.weathercode[i])}), ` +
        `wind ${Math.round(daily.windspeed_10m_max[i])}mph`
      );
    }

    const block = buildWeatherBlock(daily, `${city}, ${state}`, timezone);
    console.log(`\n✓ Weather block:\n`);
    console.log(block);
  } catch (err) {
    console.error(`✗ Failed for ${city}, ${state}:`, err.message);
  }
}
