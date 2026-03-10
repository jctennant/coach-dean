/**
 * Weather utilities for Coach Dean.
 * Uses Open-Meteo (free, no API key) for geocoding and 7-day forecasts.
 */

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

export interface DayWeather {
  date: string;        // YYYY-MM-DD
  maxTempF: number;
  minTempF: number;
  precipMm: number;
  weatherCode: number; // WMO code
  maxWindMph: number;
}

export interface WeatherForecast {
  location: string;   // "Denver, CO"
  days: DayWeather[];
}

/**
 * Geocode a city + state to lat/lon using Open-Meteo's free geocoding API.
 */
async function geocode(city: string, state: string): Promise<{ lat: number; lon: number } | null> {
  const query = `${city}, ${state}`;
  const url = `${GEOCODING_URL}?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  const data = await res.json() as { results?: Array<{ latitude: number; longitude: number }> };
  const result = data.results?.[0];
  if (!result) return null;
  return { lat: result.latitude, lon: result.longitude };
}

/**
 * Fetch a 7-day daily weather forecast for the given coordinates.
 * Returns temperatures in °F, precipitation in mm, wind in mph.
 */
async function fetchForecast(lat: number, lon: number, timezone: string): Promise<DayWeather[]> {
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

  const res = await fetch(`${FORECAST_URL}?${params}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return [];

  const data = await res.json() as {
    daily?: {
      time: string[];
      temperature_2m_max: number[];
      temperature_2m_min: number[];
      precipitation_sum: number[];
      weathercode: number[];
      windspeed_10m_max: number[];
    };
  };

  const d = data.daily;
  if (!d) return [];

  return d.time.map((date, i) => ({
    date,
    maxTempF: Math.round(d.temperature_2m_max[i]),
    minTempF: Math.round(d.temperature_2m_min[i]),
    precipMm: Math.round(d.precipitation_sum[i] * 10) / 10,
    weatherCode: d.weathercode[i],
    maxWindMph: Math.round(d.windspeed_10m_max[i]),
  }));
}

/**
 * Fetch a full week weather forecast for an athlete by city/state.
 * Returns null if location is unavailable or API calls fail.
 */
export async function fetchWeekWeather(
  city: string,
  state: string,
  timezone: string
): Promise<WeatherForecast | null> {
  try {
    const coords = await geocode(city, state);
    if (!coords) return null;
    const days = await fetchForecast(coords.lat, coords.lon, timezone);
    if (days.length === 0) return null;
    return { location: `${city}, ${state}`, days };
  } catch {
    return null;
  }
}

/** WMO weather code → human label */
function weatherLabel(code: number): string {
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

interface DayFlag {
  date: string;
  label: string;          // "Mon 3/10"
  conditions: string[];   // human-readable condition notes
  coachingNotes: string[]; // specific advice for Dean
}

/**
 * Analyze the forecast and return only notable days with coaching implications.
 * Days with ideal conditions (45–75°F, dry, calm) are omitted — no noise.
 */
export function buildWeatherBlock(forecast: WeatherForecast, timezone: string): string {
  const notable: DayFlag[] = [];

  const dayFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "numeric",
    day: "numeric",
  });

  for (const day of forecast.days) {
    const conditions: string[] = [];
    const coachingNotes: string[] = [];
    const { maxTempF, minTempF, precipMm, weatherCode, maxWindMph } = day;
    const isThunderstorm = weatherCode >= 95;
    const isSnow = weatherCode >= 71 && weatherCode <= 86;
    const isHeavyRain = (weatherCode >= 61 && weatherCode <= 65) || (weatherCode >= 80 && weatherCode <= 82);

    // Temperature flags
    if (maxTempF < 20) {
      conditions.push(`extreme cold (high ${maxTempF}°F)`);
      coachingNotes.push("Dangerous cold — treadmill is a real option worth mentioning, not just a backup. Frostbite risk on exposed skin. Mention it casually, not as a mandate.");
    } else if (maxTempF < 32) {
      conditions.push(`freezing (high ${maxTempF}°F, low ${minTempF}°F)`);
      coachingNotes.push("Ice is the main thing to flag — especially early morning. Mention it as a heads-up (footing, timing), not a rule.");
    } else if (maxTempF < 45) {
      conditions.push(`cold (high ${maxTempF}°F)`);
      coachingNotes.push("Cold but runnable. Worth a mention if it's a harder session — effort feels bigger in the cold, especially early. Layers help.");
    } else if (maxTempF >= 90) {
      conditions.push(`extreme heat (high ${maxTempF}°F)`);
      coachingNotes.push(`${maxTempF}°F is genuinely tough to run in — pace slips a lot and that's expected and fine. Early morning or evening are the best windows. Hydration and electrolytes matter more than usual. Mention it as context, not a rulebook.`);
    } else if (maxTempF >= 80) {
      conditions.push(`hot (high ${maxTempF}°F)`);
      coachingNotes.push(`Warm enough that effort will feel harder than pace suggests — worth flagging so the athlete doesn't chase numbers. Hydration is worth a mention, especially for longer runs. Keep it casual.`);
    } else if (maxTempF >= 70 && minTempF >= 60) {
      conditions.push(`warm (high ${maxTempF}°F)`);
      coachingNotes.push("Warmer than ideal training temps. A light mention — early morning is the best window, and pace might feel a touch harder. No need to make a big deal of it.");
    }

    // Precipitation / storm flags
    if (isThunderstorm) {
      conditions.push("thunderstorms");
      coachingNotes.push("Thunderstorms are the one case where moving inside is just sensible — mention it as a natural swap, not a rule.");
    } else if (isSnow && precipMm > 2) {
      conditions.push(`snow (${precipMm}mm)`);
      coachingNotes.push("Snow affects footing and pace — worth a heads-up. Some athletes love running in snow; others hate it. Treadmill is an easy alternative to mention.");
    } else if (isHeavyRain && precipMm > 10) {
      conditions.push(`heavy rain (${precipMm}mm)`);
      coachingNotes.push("Heavy rain is worth flagging, especially for quality sessions where footing and consistent pace matter. Mention treadmill as an option, not a requirement.");
    } else if (precipMm > 5) {
      conditions.push(`rain (${weatherLabel(weatherCode)}, ${precipMm}mm)`);
      // Light-moderate rain isn't a coaching concern — most runners handle it fine
    }

    // Wind flag
    if (maxWindMph >= 30) {
      conditions.push(`strong wind (${maxWindMph}mph)`);
      coachingNotes.push(`Strong wind — effort will feel harder than pace shows, especially on exposed sections. Worth mentioning as context so they're not surprised.`);
    } else if (maxWindMph >= 20) {
      conditions.push(`windy (${maxWindMph}mph)`);
      coachingNotes.push("Noticeable wind — go by feel rather than hitting a pace target.");
    }

    if (conditions.length > 0) {
      const dateObj = new Date(day.date + "T12:00:00");
      notable.push({
        date: day.date,
        label: dayFormatter.format(dateObj),
        conditions,
        coachingNotes,
      });
    }
  }

  if (notable.length === 0) return "";

  const lines = notable.map(d =>
    `${d.label}: ${d.conditions.join(", ")}. ${d.coachingNotes.join(" ")}`
  );

  return `WEATHER FORECAST — ${forecast.location} (next 7 days, notable days only):
${lines.join("\n")}
Use this when planning sessions or sending reminders. Adjust prescriptions to match conditions — don't send a tempo workout into a thunderstorm or a 90°F day without flagging it.

`;
}
