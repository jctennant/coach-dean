const LINQ_API_URL = "https://api.linqapp.com/api/partner/v3/chats";

function getConfig() {
  if (!process.env.LINQ_API_KEY)
    throw new Error("Missing LINQ_API_KEY");
  if (!process.env.LINQ_PHONE_NUMBER)
    throw new Error("Missing LINQ_PHONE_NUMBER");

  return {
    apiKey: process.env.LINQ_API_KEY,
    from: process.env.LINQ_PHONE_NUMBER,
  };
}

export async function sendSMS(to: string, body: string) {
  const { apiKey, from } = getConfig();

  const response = await fetch(LINQ_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      message: {
        parts: [
          {
            type: "text",
            value: body,
          },
        ],
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Linq API error:", response.status, errorText);
    throw new Error(`Linq API error: ${response.status}`);
  }

  return response.json();
}
