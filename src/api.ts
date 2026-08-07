// Thin client over the SV Number handler API.
//
// The API answers with plain text markers and HTTP 200, so every reply is checked against
// the marker it is supposed to start with before anything is parsed out of it.

const BASE = process.env.SVN_API_BASE
  ?? "https://sms-verification-number.com/stubs/handler_api";
const LANG = process.env.SVN_LANG ?? "en";

export class ApiError extends Error {
  constructor(public marker: string, message: string) {
    super(message);
  }
}

// what the markers mean, in words an agent can act on
const ERRORS: Record<string, string> = {
  BAD_KEY: "The API key is not accepted. Check SVN_API_KEY.",
  ERROR_SQL: "Server-side error on the provider side. Retry with a backoff.",
  ERROR_API: "Server-side error on the provider side. Retry with a backoff.",
  BAD_ACTION: "The action is not supported by the API.",
  BAD_SERVICE: "Unknown service code. Read list_services for the current codes.",
  NO_BALANCE: "The account balance is empty. It has to be topped up before ordering.",
  NO_NUMBERS: "No numbers for this country and service right now. Change country, or set operator to any.",
  NO_ACTIVATION: "Unknown activation id, or the 20 minutes already ran out.",
  CANNOT_BEFORE_2_MIN: "This cancel came too early for the API. Wait a couple of minutes and repeat.",
  REQUEST_LIMIT: "Over the rate limit. Slow the polling down.",
  WRONG_MAX_PRICE: "The max price is below the current minimum for this service.",
  BANNED: "The account is blocked.",
};

function explain(reply: string): string {
  const head = reply.split(":")[0];
  return ERRORS[head] ?? `The API answered: ${reply}`;
}

export async function call(action: string, params: Record<string, string | number> = {}): Promise<string> {
  const key = process.env.SVN_API_KEY;
  if (!key) throw new Error("SVN_API_KEY is not set in the environment.");

  const query = new URLSearchParams({ api_key: key, action, lang: LANG });
  for (const [name, value] of Object.entries(params)) query.set(name, String(value));

  const response = await fetch(`${BASE}?${query}`, { headers: { Accept: "*/*" } });
  if (!response.ok) throw new Error(`HTTP ${response.status} from the API.`);
  return (await response.text()).trim();
}

/** Calls an action that must answer with `marker`, and returns the reply. */
export async function expect(marker: string, action: string,
                             params: Record<string, string | number> = {}): Promise<string> {
  const reply = await call(action, params);
  if (!reply.startsWith(marker)) throw new ApiError(reply.split(":")[0], explain(reply));
  return reply;
}

export async function json<T>(action: string, params: Record<string, string | number> = {}): Promise<T> {
  const reply = await call(action, params);
  try {
    return JSON.parse(reply) as T;
  } catch {
    throw new ApiError(reply.split(":")[0], explain(reply));
  }
}

export const pollSeconds = Number(process.env.SVN_POLL_SECONDS ?? 4);
